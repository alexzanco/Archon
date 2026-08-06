import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
  supervisor?: SupervisorSpec;
}

interface SupervisorSpec {
  /** A policy assembled by the trusted staging CLI for this exact instance. */
  policyPath?: string;
  /** An explicit consumer-owned supervisor executable, never an import path. */
  supervisorBin?: string;
  runId?: string;
  stage?: string;
  itemKey?: string;
  externalId?: string;
  packet?: string;
  rwOutput?: string;
  capabilities?: string[];
  networkEnabled?: boolean;
  failClosed: boolean;
}

export class OsJailUnavailableError extends Error {
  readonly code = 'OS_JAIL_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'OsJailUnavailableError';
  }
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

interface WrappedAgy {
  command: string;
  args: string[];
  env: Record<string, string>;
  cleanup?: () => void;
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
    // A jailed AGY always needs a private capture root: the supervisor makes
    // its isolated HOME below this directory and the provider owns deletion
    // only after the tailer has consumed the final transcript bytes.
    const transcriptCapture =
      runOptions.transcriptToolEvents || runOptions.supervisor
        ? createTranscriptCapture()
        : undefined;
    const args = buildAgyArgs(runOptions, finalPrompt, transcriptCapture?.logFilePath);

    try {
      getLog().debug(
        {
          cwd,
          hasModel: runOptions.model !== undefined,
          osJail: runOptions.supervisor !== undefined,
        },
        'agy.query_started'
      );
      const run = startAgyPrint(
        binaryPath,
        args,
        cwd,
        options,
        runOptions.supervisor,
        transcriptCapture?.directory
      );
      if (transcriptCapture && runOptions.transcriptToolEvents) {
        try {
          for await (const chunk of tailAgyToolChunksFromLog(
            transcriptCapture.logFilePath,
            run.done,
            runOptions.supervisor ? transcriptCapture.directory : undefined
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
    supervisor: resolveSupervisor(nodeConfig?.sandbox),
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
  options: SendQueryOptions | undefined,
  supervisor: SupervisorSpec | undefined,
  captureRoot: string | undefined
): RunningAgyPrint {
  const abortSignal = options?.abortSignal;
  if (abortSignal?.aborted) {
    throw new Error('AGY query aborted before start');
  }

  const environment = buildAgyEnv(options?.env);
  const wrapped = wrapWithSupervisor(binaryPath, args, environment, supervisor, captureRoot);
  const child = spawn(wrapped.command, wrapped.args, {
    cwd,
    env: wrapped.env,
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
    wrapped.cleanup?.();
  });

  done.catch(() => {
    // The provider awaits `done` after transcript tailing. Attach this handler so
    // fast CLI failures do not report an unhandled rejection while the tailer is
    // doing its final poll.
  });

  return { done };
}

/**
 * Resolve the sandbox supervisor binary to an executable path. Accepts an
 * explicit path (containing a slash) or a bare command name looked up on PATH.
 * Returns undefined when nothing executable is found; callers decide whether that
 * is fatal (fail_closed) or a permitted unconfined fallback.
 */
function resolveSupervisorBinary(requested?: string): string | undefined {
  const configured = requested ?? process.env.ZANCO_SANDBOX_BIN ?? 'zanco-sandbox';
  if (configured.includes('/')) {
    return existsSync(configured) ? configured : undefined;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, configured);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function wrapWithSupervisor(
  binaryPath: string,
  agyArgs: string[],
  environment: Record<string, string>,
  spec: SupervisorSpec | undefined,
  captureRoot: string | undefined
): WrappedAgy {
  if (!spec) return { command: binaryPath, args: agyArgs, env: environment };
  if (!captureRoot) {
    throw new OsJailUnavailableError('OS-jailed AGY requires a private capture root');
  }
  const supervisorPath = resolveSupervisorBinary(spec.supervisorBin);
  if (!supervisorPath) {
    // A fail_closed node must never silently run unconfined when its enforcement
    // binary cannot be resolved. This covers a bare `zanco-sandbox` that is not on
    // PATH — the exact gap that let authors run unjailed in the 2026-07-22
    // rehearsal even though the jail was fully wired on every side.
    if (spec.failClosed) {
      throw new OsJailUnavailableError(
        'zanco-sandbox is unavailable (checked ZANCO_SANDBOX_BIN and PATH); ' +
          'refusing to run a fail_closed author unconfined'
      );
    }
    return { command: binaryPath, args: agyArgs, env: environment };
  }
  // The trusted stage CLI owns policy construction.  Keep Archon as a router:
  // it receives the resolved per-instance path and prefixes the provider command.
  if (spec.policyPath) {
    return {
      command: supervisorPath,
      args: [
        'run',
        '--policy',
        spec.policyPath,
        '--capture-root',
        captureRoot,
        '--',
        binaryPath,
        ...agyArgs,
      ],
      env: environment,
    };
  }
  const directory = mkdtempSync(join(tmpdir(), 'archon-zanco-policy-'));
  const policyPath = join(directory, 'policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      run_id: spec.runId,
      stage: spec.stage,
      item_key: spec.itemKey,
      external_id: spec.externalId,
      packet: spec.packet,
      rw_output: spec.rwOutput,
      capabilities: spec.capabilities,
      net: spec.networkEnabled,
      fail_closed: spec.failClosed,
    })
  );
  return {
    command: supervisorPath,
    args: [
      'run',
      '--policy',
      policyPath,
      '--capture-root',
      captureRoot,
      '--',
      binaryPath,
      ...agyArgs,
    ],
    env: environment,
    cleanup: (): void => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function createTranscriptCapture(): AgyTranscriptCapture {
  const directory = mkdtempSync(join(tmpdir(), 'archon-agy-'));
  return { directory, logFilePath: join(directory, 'agy.log') };
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<AgyExit> {
  const eventedChild = child as unknown as {
    once(event: 'error', listener: (error: Error) => void): void;
    once(
      event: 'close',
      listener: (code: number | null, signal: NodeJS.Signals | null) => void
    ): void;
  };
  return new Promise((resolve, reject) => {
    eventedChild.once('error', reject);
    eventedChild.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
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

function resolveSupervisor(rawSandbox: unknown): SupervisorSpec | undefined {
  if (!rawSandbox || typeof rawSandbox !== 'object') return undefined;
  const sandbox = rawSandbox as Record<string, unknown>;
  if (sandbox.os !== 'bwrap') return undefined;
  const policyPath = stringFromNode(sandbox.policy_path);
  const supervisorBin = stringFromNode(sandbox.supervisor_bin);
  if (policyPath) {
    return { policyPath, supervisorBin, failClosed: sandbox.fail_closed !== false };
  }
  const packet = stringFromNode(sandbox.packet);
  const rwOutput = stringFromNode(sandbox.rw_output);
  const runId = stringFromNode(sandbox.run_id);
  const stage = stringFromNode(sandbox.stage);
  const itemKey = stringFromNode(sandbox.item_key);
  const externalId = stringFromNode(sandbox.external_id);
  const capabilities = stringArrayFromNode(sandbox.capabilities);
  if (!packet || !rwOutput || !runId || !stage || !itemKey || !externalId || !capabilities.length) {
    throw new OsJailUnavailableError(
      'sandbox.os=bwrap requires resolved packet, rw_output, run_id, stage, item_key, external_id, and capabilities'
    );
  }
  return {
    runId,
    stage,
    itemKey,
    supervisorBin,
    externalId,
    packet,
    rwOutput,
    capabilities,
    networkEnabled: sandbox.net === true,
    failClosed: sandbox.fail_closed !== false,
  };
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
