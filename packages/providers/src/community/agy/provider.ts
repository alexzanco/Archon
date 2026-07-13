import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@archon/paths';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';
import {
  augmentPromptForJsonSchema,
  tryParseStructuredOutput,
} from '../../shared/structured-output';
import { AGY_CAPABILITIES } from './capabilities';
import { resolveAgyBinaryPath } from './binary-resolver';
import { parseAgyConfig, type AgyProviderDefaults } from './config';
import { tailAgyToolChunksFromLog } from './transcript-tools';

interface AgyRunOptions {
  model?: string;
  printTimeout?: string;
  sandbox: boolean;
  dangerouslySkipPermissions: boolean;
  additionalDirectories: string[];
  transcriptToolEvents: boolean;
}

interface AgyTranscriptCapture {
  directory: string;
  logFilePath: string;
}

interface AgyExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface RunningAgyPrint {
  done: Promise<{ stdout: string; stderr: string }>;
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.agy');
  return cachedLog;
}

export class AgyProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    cwd: string,
    _resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const config = parseAgyConfig(options?.assistantConfig ?? {});
    const runOptions = resolveRunOptions(config, options);
    const binaryPath = await resolveAgyBinaryPath(config.agyBinaryPath);
    const finalPrompt =
      options?.outputFormat?.type === 'json_schema'
        ? augmentPromptForJsonSchema(prompt, options.outputFormat.schema)
        : prompt;
    const transcriptCapture = runOptions.transcriptToolEvents
      ? createTranscriptCapture()
      : undefined;
    const args = buildAgyArgs(runOptions, finalPrompt, transcriptCapture?.logFilePath);

    try {
      getLog().debug({ cwd, hasModel: runOptions.model !== undefined }, 'agy.query_started');
      const run = startAgyPrint(binaryPath, args, cwd, options);
      if (transcriptCapture) {
        try {
          for await (const chunk of tailAgyToolChunksFromLog(
            transcriptCapture.logFilePath,
            run.done
          )) {
            yield chunk;
          }
        } catch (error) {
          getLog().warn({ err: error }, 'agy.transcript_tool_events_failed');
        }
      }

      const result = await run.done;
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      if (isAgyAuthFailure(combinedOutput)) {
        throw new Error(formatAgyAuthError());
      }

      const content = result.stdout.trim();
      if (content.length > 0) {
        yield { type: 'assistant', content };
      }

      const resultChunk: MessageChunk = { type: 'result' };
      if (options?.outputFormat?.type === 'json_schema') {
        const structuredOutput = tryParseStructuredOutput(content);
        if (structuredOutput !== undefined) {
          resultChunk.structuredOutput = structuredOutput;
        } else {
          getLog().warn({}, 'agy.structured_output_parse_failed');
        }
      }
      yield resultChunk;
    } finally {
      if (transcriptCapture) {
        rmSync(transcriptCapture.directory, { recursive: true, force: true });
      }
    }
  }

  getType(): string {
    return 'agy';
  }

  getCapabilities(): ProviderCapabilities {
    return AGY_CAPABILITIES;
  }
}

function resolveRunOptions(
  config: AgyProviderDefaults,
  options: SendQueryOptions | undefined
): AgyRunOptions {
  const nodeConfig = options?.nodeConfig;
  return {
    model: options?.model ?? stringFromNode(nodeConfig?.model) ?? config.model,
    printTimeout: stringFromNode(nodeConfig?.printTimeout) ?? config.printTimeout,
    sandbox: resolveSandbox(nodeConfig?.sandbox, config.sandbox),
    dangerouslySkipPermissions:
      booleanFromNode(nodeConfig?.dangerouslySkipPermissions) ??
      booleanFromNode(nodeConfig?.dangerously_skip_permissions) ??
      config.dangerouslySkipPermissions ??
      false,
    transcriptToolEvents:
      booleanFromNode(nodeConfig?.transcriptToolEvents) ??
      booleanFromNode(nodeConfig?.transcript_tool_events) ??
      config.transcriptToolEvents ??
      true,
    additionalDirectories: [
      ...(config.additionalDirectories ?? []),
      ...stringArrayFromNode(nodeConfig?.additionalDirectories),
      ...stringArrayFromNode(nodeConfig?.additional_directories),
    ],
  };
}

function buildAgyArgs(
  options: AgyRunOptions,
  prompt: string,
  logFilePath: string | undefined
): string[] {
  const args = ['--print', prompt];

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.printTimeout) {
    args.push('--print-timeout', options.printTimeout);
  }

  if (options.sandbox) {
    args.push('--sandbox');
  }

  if (options.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  if (logFilePath) {
    args.push('--log-file', logFilePath);
  }

  for (const directory of options.additionalDirectories) {
    args.push('--add-dir', directory);
  }

  return args;
}

function startAgyPrint(
  binaryPath: string,
  args: string[],
  cwd: string,
  options: SendQueryOptions | undefined
): RunningAgyPrint {
  const abortSignal = options?.abortSignal;
  if (abortSignal?.aborted) {
    throw new Error('AGY query aborted before start');
  }

  const child = spawn(binaryPath, args, {
    cwd,
    env: buildAgyEnv(options?.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const onAbort = (): void => {
    child.kill('SIGTERM');
  };
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  const done = (async (): Promise<{ stdout: string; stderr: string }> => {
    const exit = await waitForExit(child);
    if (exit.signal) {
      throw new Error(`AGY CLI was terminated by signal ${exit.signal}`);
    }
    if (exit.code !== 0) {
      const combinedOutput = `${stdout}\n${stderr}`;
      if (isAgyAuthFailure(combinedOutput)) {
        throw new Error(formatAgyAuthError());
      }
      throw new Error(
        `AGY CLI failed with exit code ${exit.code}.\n` +
          `stderr:\n${preview(stderr)}\n\nstdout:\n${preview(stdout)}`
      );
    }
    return { stdout, stderr };
  })().finally(() => {
    abortSignal?.removeEventListener('abort', onAbort);
  });

  done.catch(() => {
    // The provider awaits `done` after transcript tailing. Attach this handler so
    // fast CLI failures do not report an unhandled rejection while the tailer is
    // doing its final poll.
  });

  return { done };
}

function createTranscriptCapture(): AgyTranscriptCapture {
  const directory = mkdtempSync(join(tmpdir(), 'archon-agy-'));
  return { directory, logFilePath: join(directory, 'agy.log') };
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<AgyExit> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      resolve({ code, signal });
    });
  });
}

function buildAgyEnv(requestEnv?: Record<string, string>): Record<string, string> {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  return { ...baseEnv, ...(requestEnv ?? {}) };
}

function resolveSandbox(rawSandbox: unknown, configSandbox: boolean | undefined): boolean {
  if (typeof rawSandbox === 'boolean') return rawSandbox;
  if (rawSandbox && typeof rawSandbox === 'object') {
    const record = rawSandbox as Record<string, unknown>;
    if (typeof record.enabled === 'boolean') return record.enabled;
    return true;
  }
  return configSandbox ?? false;
}

function stringFromNode(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function booleanFromNode(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayFromNode(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function isAgyAuthFailure(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('not logged in') ||
    normalized.includes('not logged into antigravity') ||
    normalized.includes('authentication required') ||
    normalized.includes('authentication interrupted') ||
    normalized.includes('please sign in') ||
    normalized.includes('sign in to antigravity') ||
    normalized.includes('google sign-in')
  );
}

function formatAgyAuthError(): string {
  return (
    'AGY is not logged in. Run `agy` once in a terminal and complete Google Sign-In, ' +
    'then verify the login with `agy models`. Archon does not perform AGY OAuth or token delivery.'
  );
}

function preview(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 2000) return trimmed;
  return `${trimmed.slice(0, 2000)}...`;
}
