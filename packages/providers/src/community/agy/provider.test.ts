import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';

import type { MessageChunk, SendQueryOptions } from '../../types';
import { AgyProvider, OsJailUnavailableError, assertModelPinHonoured } from './provider';
import { readAgyToolChunksFromTranscript } from './transcript-tools';

const tmpRoot = mkdtempSync(join(tmpdir(), 'archon-agy-provider-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('AgyProvider', () => {
  test('replays the sanitized July 23 native transcript including string BypassSandbox metadata', async () => {
    const fixture = join(import.meta.dir, '__fixtures__', 'sanitized-july23-transcript_full.jsonl');
    const chunks = await readAgyToolChunksFromTranscript(fixture);
    // Sanitized fixture: 13 representative calls (not the original 63); the
    // string-valued permission metadata is parser data, not a namespace escape.
    expect(chunks.filter(chunk => chunk.type === 'tool')).toHaveLength(13);
    expect(chunks.filter(chunk => chunk.type === 'tool_result')).toHaveLength(13);
    expect(chunks[0]).toMatchObject({ type: 'tool', toolName: 'List Dir' });
  });

  test('spawns agy --print with supported options', async () => {
    const fakeAgy = writeExecutable(
      'agy-args',
      '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done > "$AGY_ARGS_FILE"\nprintf "%s" "hello from agy"\n'
    );
    const argsFile = join(tmpRoot, 'args.txt');
    const provider = new AgyProvider();

    const chunks = await collect(
      provider.sendQuery('Say hello', tmpRoot, undefined, {
        env: { AGY_ARGS_FILE: argsFile },
        assistantConfig: {
          agyBinaryPath: fakeAgy,
          model: 'Gemini 3.1 Pro (High)',
          printTimeout: '10s',
          sandbox: true,
          dangerouslySkipPermissions: true,
          transcriptToolEvents: false,
          additionalDirectories: ['/extra/config'],
        },
        nodeConfig: {
          additionalDirectories: ['/extra/node'],
        },
      })
    );

    expect(chunks).toEqual([{ type: 'assistant', content: 'hello from agy' }, { type: 'result' }]);
    expect(readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
      '--print',
      'Say hello',
      '--model',
      'Gemini 3.1 Pro (High)',
      '--print-timeout',
      '10s',
      '--sandbox',
      '--dangerously-skip-permissions',
      '--add-dir',
      '/extra/config',
      '--add-dir',
      '/extra/node',
    ]);
  });

  test('uses prompt augmentation and best-effort JSON parse for output_format', async () => {
    const fakeAgy = writeExecutable(
      'agy-json',
      '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n---ARG---\\n" "$arg"; done > "$AGY_ARGS_FILE"\nprintf "%s" "Result: {\\"ok\\":true}"\n'
    );
    const argsFile = join(tmpRoot, 'json-args.txt');
    const provider = new AgyProvider();

    const chunks = await collect(
      provider.sendQuery('Return status', tmpRoot, undefined, {
        env: { AGY_ARGS_FILE: argsFile },
        assistantConfig: { agyBinaryPath: fakeAgy, transcriptToolEvents: false },
        outputFormat: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
        },
      })
    );

    expect(chunks[0]).toEqual({ type: 'assistant', content: 'Result: {"ok":true}' });
    expect(chunks[1]).toEqual({ type: 'result', structuredOutput: { ok: true } });
    expect(readFileSync(argsFile, 'utf8')).toContain('CRITICAL: Respond with ONLY a JSON object');
  });

  test('fails clearly when AGY reports an auth failure', async () => {
    const fakeAgy = writeExecutable(
      'agy-auth',
      '#!/bin/sh\necho "Authentication required. Please sign in to Antigravity." >&2\nexit 1\n'
    );
    const provider = new AgyProvider();

    await expect(
      collect(
        provider.sendQuery('hello', tmpRoot, undefined, {
          assistantConfig: { agyBinaryPath: fakeAgy, transcriptToolEvents: false },
        })
      )
    ).rejects.toThrow('AGY is not logged in');
  });

  test('node options override config model and sandbox values', async () => {
    const fakeAgy = writeExecutable(
      'agy-node-overrides',
      '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done > "$AGY_ARGS_FILE"\n'
    );
    const argsFile = join(tmpRoot, 'node-overrides-args.txt');
    const provider = new AgyProvider();

    await collect(
      provider.sendQuery('Prompt', tmpRoot, undefined, {
        env: { AGY_ARGS_FILE: argsFile },
        assistantConfig: {
          agyBinaryPath: fakeAgy,
          model: 'Gemini 3.5 Flash (High)',
          sandbox: true,
          transcriptToolEvents: false,
        },
        nodeConfig: {
          model: 'Gemini 3.1 Pro (High)',
          sandbox: false,
          printTimeout: '1m0s',
        },
      })
    );

    expect(readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
      '--print',
      'Prompt',
      '--model',
      'Gemini 3.1 Pro (High)',
      '--print-timeout',
      '1m0s',
    ]);
  });

  test('prefixes an OS-jailed node with the sandbox supervisor', async () => {
    const fakeAgy = writeExecutable('agy-jailed', '#!/bin/sh\nprintf "%s" "unreachable"\n');
    const fakeBwrap = writeExecutable(
      'supervisor-args',
      '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done > "$SUPERVISOR_ARGS_FILE"\nprintf "%s" "jailed"\n'
    );
    const packet = join(tmpRoot, 'packet.json');
    const output = join(tmpRoot, 'jail-output');
    const policy = join(tmpRoot, 'stage-policy.json');
    const argsFile = join(tmpRoot, 'supervisor-args.txt');
    writeFileSync(packet, '{}');
    writeFileSync(policy, '{}');
    mkdirSync(output, { recursive: true });
    const previousSupervisorPath = process.env.ZANCO_SANDBOX_BIN;
    process.env.ZANCO_SANDBOX_BIN = fakeBwrap;

    try {
      const chunks = await collect(
        new AgyProvider().sendQuery('jail me', tmpRoot, undefined, {
          env: { SUPERVISOR_ARGS_FILE: argsFile },
          assistantConfig: { agyBinaryPath: fakeAgy, transcriptToolEvents: false },
          nodeConfig: {
            sandbox: {
              os: 'bwrap',
              policy_path: policy,
              fail_closed: true,
            },
          },
        })
      );
      expect(chunks).toEqual([
        { type: 'assistant', content: 'jailed' },
        { type: 'result', captureRoot: expect.any(String) },
      ]);
      const result = chunks.at(-1);
      if (result?.type === 'result' && result.captureRoot) {
        rmSync(result.captureRoot, { recursive: true, force: true });
      }
      const supervisorArgs = readFileSync(argsFile, 'utf8').trim().split('\n');
      expect(supervisorArgs).toContain('run');
      expect(supervisorArgs).toContain('--policy');
      expect(supervisorArgs).toContain(policy);
      expect(supervisorArgs).toContain('--');
      expect(supervisorArgs).toContain(fakeAgy);
      expect(supervisorArgs).not.toContain('--sandbox');
    } finally {
      if (previousSupervisorPath === undefined) delete process.env.ZANCO_SANDBOX_BIN;
      else process.env.ZANCO_SANDBOX_BIN = previousSupervisorPath;
    }
  });

  test('accepts the bootstrap fallback when AGY later resolves the pin', () => {
    // Verbatim from run 670d7c62, where the pin WAS honoured. The fallback fires
    // before auth, when the jailed HOME still has no cached model list; treating
    // it alone as a downgrade discarded a correct artifact.
    const honoured = [
      'I0806 21:58:04.417746 resolver.go:85] Model ID gemini-3.6-flash-medium not in local config, defaulting to CCPA',
      'I0806 21:58:04.938295 model_configs.go:59] Auth mode is unspecified, skipping fetchAvailableModels',
      'I0806 21:58:06.417758 http_helpers.go:228] URL: .../v1internal:fetchAvailableModels',
      'I0806 21:58:06.423278 model_resolver.go:73] Resolving model gemini-3.6-flash-medium',
      'I0806 21:58:06.423315 model_config_manager.go:311] Propagating selected model override to backend: label="Gemini 3.6 Flash (Medium)"',
    ].join('\n');
    expect(() => assertModelPinHonoured('gemini-3.6-flash-medium', honoured)).not.toThrow();
  });

  test('refuses a pin that fell back and was never resolved', () => {
    const downgraded =
      'I0806 21:58:04.417746 resolver.go:85] Model ID gemini-3.6-flash-medium not in local config, defaulting to CCPA';
    expect(() => assertModelPinHonoured('gemini-3.6-flash-medium', downgraded)).toThrow(
      /did not honour requested model/
    );
  });

  test('refuses a run whose pinned model AGY silently downgraded', async () => {
    // The jailed HOME has no cached model config and auth never recovers, so the
    // fallback stands with no later `Resolving model <id>` line.
    const fakeAgy = writeExecutable(
      'agy-downgraded-model',
      '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--log-file" ]; then shift; printf "Model ID gemini-3.6-flash-medium not in local config, defaulting to CCPA\\n" > "$1"; fi\n  shift\ndone\nprintf "%s" "answered anyway"\n'
    );
    const fakeSupervisor = writeExecutable(
      'downgraded-model-supervisor',
      '#!/bin/sh\nshift\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n'
    );
    const policy = join(tmpRoot, 'downgraded-model-policy.json');
    writeFileSync(policy, '{}');
    const previousSupervisorPath = process.env.ZANCO_SANDBOX_BIN;
    process.env.ZANCO_SANDBOX_BIN = fakeSupervisor;
    try {
      const attempt = collect(
        new AgyProvider().sendQuery('pin me', tmpRoot, undefined, {
          model: 'gemini-3.6-flash-medium',
          assistantConfig: { agyBinaryPath: fakeAgy, transcriptToolEvents: false },
          nodeConfig: {
            sandbox: { os: 'bwrap', policy_path: policy, fail_closed: true },
          },
        })
      );
      await expect(attempt).rejects.toThrow(/did not honour requested model/);
    } finally {
      if (previousSupervisorPath === undefined) delete process.env.ZANCO_SANDBOX_BIN;
      else process.env.ZANCO_SANDBOX_BIN = previousSupervisorPath;
    }
  });

  test('seeds the AGY OAuth token into the supervisor when the host has one', async () => {
    const fakeAgy = writeExecutable('agy-seeded', '#!/bin/sh\nprintf "%s" "seeded"\n');
    const fakeSupervisor = writeExecutable(
      'seeded-supervisor',
      '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done > "$SUPERVISOR_ARGS_FILE"\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n'
    );
    const policy = join(tmpRoot, 'seeded-policy.json');
    const argsFile = join(tmpRoot, 'seeded-args.txt');
    writeFileSync(policy, '{}');
    const fakeHome = join(tmpRoot, 'seeded-home');
    const tokenPath = join(fakeHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, 'host-token');
    const previousSupervisorPath = process.env.ZANCO_SANDBOX_BIN;
    const previousHome = process.env.HOME;
    process.env.ZANCO_SANDBOX_BIN = fakeSupervisor;
    process.env.HOME = fakeHome;
    try {
      const chunks = await collect(
        new AgyProvider().sendQuery('seed me', tmpRoot, undefined, {
          env: { SUPERVISOR_ARGS_FILE: argsFile },
          assistantConfig: { agyBinaryPath: fakeAgy, transcriptToolEvents: false },
          nodeConfig: {
            sandbox: { os: 'bwrap', policy_path: policy, fail_closed: true },
          },
        })
      );
      const result = chunks.at(-1);
      if (result?.type === 'result' && result.captureRoot) {
        rmSync(result.captureRoot, { recursive: true, force: true });
      }
      const supervisorArgs = readFileSync(argsFile, 'utf8').trim().split('\n');
      expect(supervisorArgs).toContain('--seed-file');
      expect(supervisorArgs).toContain(
        `${tokenPath}:.gemini/antigravity-cli/antigravity-oauth-token`
      );
      // The seed must precede the `--` that ends supervisor arguments.
      expect(supervisorArgs.indexOf('--seed-file')).toBeLessThan(supervisorArgs.indexOf('--'));
    } finally {
      if (previousSupervisorPath === undefined) delete process.env.ZANCO_SANDBOX_BIN;
      else process.env.ZANCO_SANDBOX_BIN = previousSupervisorPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('passes no seed when the host has no AGY token', async () => {
    const fakeAgy = writeExecutable('agy-unseeded', '#!/bin/sh\nprintf "%s" "unseeded"\n');
    const fakeSupervisor = writeExecutable(
      'unseeded-supervisor',
      '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done > "$SUPERVISOR_ARGS_FILE"\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n'
    );
    const policy = join(tmpRoot, 'unseeded-policy.json');
    const argsFile = join(tmpRoot, 'unseeded-args.txt');
    writeFileSync(policy, '{}');
    const emptyHome = join(tmpRoot, 'empty-home');
    mkdirSync(emptyHome, { recursive: true });
    const previousSupervisorPath = process.env.ZANCO_SANDBOX_BIN;
    const previousHome = process.env.HOME;
    process.env.ZANCO_SANDBOX_BIN = fakeSupervisor;
    process.env.HOME = emptyHome;
    try {
      const chunks = await collect(
        new AgyProvider().sendQuery('no seed', tmpRoot, undefined, {
          env: { SUPERVISOR_ARGS_FILE: argsFile },
          assistantConfig: { agyBinaryPath: fakeAgy, transcriptToolEvents: false },
          nodeConfig: {
            sandbox: { os: 'bwrap', policy_path: policy, fail_closed: true },
          },
        })
      );
      const result = chunks.at(-1);
      if (result?.type === 'result' && result.captureRoot) {
        rmSync(result.captureRoot, { recursive: true, force: true });
      }
      expect(readFileSync(argsFile, 'utf8')).not.toContain('--seed-file');
    } finally {
      if (previousSupervisorPath === undefined) delete process.env.ZANCO_SANDBOX_BIN;
      else process.env.ZANCO_SANDBOX_BIN = previousSupervisorPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test('keeps an explicitly enabled provider sandbox inside an OS jail', async () => {
    const fakeAgy = writeExecutable(
      'agy-explicit-inner-sandbox',
      '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done > "$AGY_ARGS_FILE"\n'
    );
    const fakeSupervisor = writeExecutable(
      'explicit-inner-sandbox-supervisor',
      '#!/bin/sh\nshift\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n'
    );
    const policy = join(tmpRoot, 'explicit-inner-sandbox-policy.json');
    const argsFile = join(tmpRoot, 'explicit-inner-sandbox-args.txt');
    writeFileSync(policy, '{}');
    const previousSupervisorPath = process.env.ZANCO_SANDBOX_BIN;
    process.env.ZANCO_SANDBOX_BIN = fakeSupervisor;
    try {
      await collect(
        new AgyProvider().sendQuery('jail me', tmpRoot, undefined, {
          env: { AGY_ARGS_FILE: argsFile },
          assistantConfig: { agyBinaryPath: fakeAgy, sandbox: true, transcriptToolEvents: false },
          nodeConfig: {
            sandbox: { os: 'bwrap', enabled: true, policy_path: policy, fail_closed: true },
          },
        })
      );
      expect(readFileSync(argsFile, 'utf8')).toContain('--sandbox');
    } finally {
      if (previousSupervisorPath === undefined) delete process.env.ZANCO_SANDBOX_BIN;
      else process.env.ZANCO_SANDBOX_BIN = previousSupervisorPath;
    }
  });

  test('retains an accounting capture after a supervised run completes', async () => {
    const fakeAgy = writeExecutable('agy-retained-capture', '#!/bin/sh\nexit 0\n');
    const fakeSupervisor = writeExecutable(
      'retained-capture-supervisor',
      `#!/bin/sh
capture_root=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--capture-root" ]; then
    shift
    capture_root="$1"
  fi
  shift
done
mkdir -p "$capture_root/home/.config/antigravity"
printf 'accounting metadata' > "$capture_root/home/.config/antigravity/gen_metadata"
printf '%s' "jailed"
`
    );
    const policy = join(tmpRoot, 'retained-capture-policy.json');
    writeFileSync(policy, '{}');
    const previousSupervisorPath = process.env.ZANCO_SANDBOX_BIN;
    process.env.ZANCO_SANDBOX_BIN = fakeSupervisor;

    try {
      const chunks = await collect(
        new AgyProvider().sendQuery('retain accounting', tmpRoot, undefined, {
          assistantConfig: { agyBinaryPath: fakeAgy, transcriptToolEvents: false },
          nodeConfig: {
            sandbox: { os: 'bwrap', policy_path: policy, fail_closed: true },
          },
        })
      );
      expect(chunks).toEqual([
        { type: 'assistant', content: 'jailed' },
        { type: 'result', captureRoot: expect.any(String) },
      ]);
      const result = chunks.at(-1);
      if (result?.type !== 'result' || !result.captureRoot) {
        throw new Error('supervised run did not expose its retained capture root');
      }
      const captureRoot = result.captureRoot;
      const metadata = join(captureRoot, 'home', '.config', 'antigravity', 'gen_metadata');
      expect(existsSync(metadata)).toBe(true);
      expect(readFileSync(metadata, 'utf8')).toBe('accounting metadata');
      rmSync(captureRoot, { recursive: true, force: true });
    } finally {
      if (previousSupervisorPath === undefined) delete process.env.ZANCO_SANDBOX_BIN;
      else process.env.ZANCO_SANDBOX_BIN = previousSupervisorPath;
    }
  });

  test('cleans up a transcript-only capture after an unsupervised run', async () => {
    const argsFile = join(tmpRoot, 'unsupervised-transcript-args.txt');
    const fakeAgy = writeExecutable(
      'agy-unsupervised-transcript',
      '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done > "$AGY_ARGS_FILE"\nprintf "%s" "done"\n'
    );

    await collect(
      new AgyProvider().sendQuery('transcript only', tmpRoot, undefined, {
        env: { AGY_ARGS_FILE: argsFile },
        assistantConfig: { agyBinaryPath: fakeAgy, transcriptToolEvents: true },
      })
    );

    const args = readFileSync(argsFile, 'utf8').trim().split('\n');
    const logFilePath = args[args.indexOf('--log-file') + 1];
    expect(existsSync(dirname(logFilePath))).toBe(false);
  });

  test('fails typed when bwrap is unavailable and fail_closed is set', async () => {
    const fakeAgy = writeExecutable('agy-missing-bwrap', '#!/bin/sh\nexit 0\n');
    const packet = join(tmpRoot, 'missing-bwrap-packet.json');
    const output = join(tmpRoot, 'missing-bwrap-output');
    writeFileSync(packet, '{}');
    mkdirSync(output, { recursive: true });
    const previousSupervisorPath = process.env.ZANCO_SANDBOX_BIN;
    process.env.ZANCO_SANDBOX_BIN = join(tmpRoot, 'not-supervisor');

    try {
      await expect(
        collect(
          new AgyProvider().sendQuery('jail me', tmpRoot, undefined, {
            assistantConfig: { agyBinaryPath: fakeAgy, transcriptToolEvents: false },
            nodeConfig: {
              sandbox: {
                os: 'bwrap',
                packet,
                rw_output: output,
                run_id: 'run-1',
                stage: 'curate',
                item_key: 'slot-1',
                external_id: 'ext-1',
                capabilities: ['source.get-slice'],
                fail_closed: true,
              },
            },
          })
        )
      ).rejects.toBeInstanceOf(OsJailUnavailableError);
    } finally {
      if (previousSupervisorPath === undefined) delete process.env.ZANCO_SANDBOX_BIN;
      else process.env.ZANCO_SANDBOX_BIN = previousSupervisorPath;
    }
  });

  test('fails typed when supervisor is a bare command absent from PATH and fail_closed is set', async () => {
    // Regression for the 2026-07-22 rehearsal: ZANCO_SANDBOX_BIN unset defaults to
    // the bare name `zanco-sandbox`. The old guard only checked paths containing a
    // slash, so a bare command missing from PATH bypassed fail-closed and the
    // author ran unconfined. Point PATH at a directory without the binary.
    const fakeAgy = writeExecutable('agy-bare-supervisor', '#!/bin/sh\nexit 0\n');
    const packet = join(tmpRoot, 'bare-supervisor-packet.json');
    const output = join(tmpRoot, 'bare-supervisor-output');
    const policy = join(tmpRoot, 'bare-supervisor-policy.json');
    writeFileSync(packet, '{}');
    writeFileSync(policy, '{}');
    mkdirSync(output, { recursive: true });
    const emptyBinDir = join(tmpRoot, 'empty-bin');
    mkdirSync(emptyBinDir, { recursive: true });
    const previousSupervisorPath = process.env.ZANCO_SANDBOX_BIN;
    const previousPath = process.env.PATH;
    delete process.env.ZANCO_SANDBOX_BIN;
    process.env.PATH = emptyBinDir;

    try {
      await expect(
        collect(
          new AgyProvider().sendQuery('jail me', tmpRoot, undefined, {
            assistantConfig: { agyBinaryPath: fakeAgy, transcriptToolEvents: false },
            nodeConfig: {
              sandbox: {
                os: 'bwrap',
                policy_path: policy,
                fail_closed: true,
              },
            },
          })
        )
      ).rejects.toBeInstanceOf(OsJailUnavailableError);
    } finally {
      if (previousSupervisorPath === undefined) delete process.env.ZANCO_SANDBOX_BIN;
      else process.env.ZANCO_SANDBOX_BIN = previousSupervisorPath;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test('emits best-effort tool chunks from AGY transcript logs', async () => {
    const conversationId = 'ab880491-881c-47be-8553-928097aced5f';
    const appDataDir = join(tmpRoot, 'antigravity-cli-data');
    const fakeAgy = writeExecutable(
      'agy-transcript',
      `#!/bin/sh
log_file=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--log-file" ]; then
    shift
    log_file="$1"
  fi
  shift
done

transcript_dir="$AGY_APP_DATA_DIR/brain/$AGY_CONVERSATION_ID/.system_generated/logs"
mkdir -p "$transcript_dir"
printf 'I0622 common.go:156] CLI app data directory: %s\\nI0622 printmode.go:156] Print mode: conversation=%s, sending message\\n' "$AGY_APP_DATA_DIR" "$AGY_CONVERSATION_ID" > "$log_file"
cat > "$transcript_dir/transcript_full.jsonl" <<'JSONL'
{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"Run pwd"}
{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command","args":{"CommandLine":"pwd","Cwd":"/repo"}}]}
{"step_index":2,"source":"MODEL","type":"RUN_COMMAND","status":"DONE","content":"Created At: now\\nCompleted At: now\\n\\nOutput:\\n/repo\\n"}
{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"final answer"}
JSONL
printf "%s" "final answer"
`
    );
    const provider = new AgyProvider();

    const chunks = await collect(
      provider.sendQuery('Run pwd', tmpRoot, undefined, {
        env: {
          AGY_APP_DATA_DIR: appDataDir,
          AGY_CONVERSATION_ID: conversationId,
        },
        assistantConfig: { agyBinaryPath: fakeAgy },
      })
    );

    expect(chunks).toEqual([
      {
        type: 'tool',
        toolName: 'Run Command',
        toolInput: { CommandLine: 'pwd', Cwd: '/repo' },
        toolCallId: '1:0',
      },
      {
        type: 'tool_result',
        toolName: 'Run Command',
        toolOutput: 'Created At: now\nCompleted At: now\n\nOutput:\n/repo\n',
        toolCallId: '1:0',
      },
      { type: 'assistant', content: 'final answer' },
      { type: 'result' },
    ]);
  });

  test('tails transcript tool chunks before final stdout is available', async () => {
    const conversationId = '2d8c56de-4b93-43a5-9290-bf8e0f433901';
    const appDataDir = join(tmpRoot, 'antigravity-cli-live-data');
    const fakeAgy = writeExecutable(
      'agy-live-transcript',
      `#!/bin/sh
log_file=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--log-file" ]; then
    shift
    log_file="$1"
  fi
  shift
done

transcript_dir="$AGY_APP_DATA_DIR/brain/$AGY_CONVERSATION_ID/.system_generated/logs"
mkdir -p "$transcript_dir"
printf 'I0622 common.go:156] CLI app data directory: %s\\nI0622 printmode.go:156] Print mode: conversation=%s, sending message\\n' "$AGY_APP_DATA_DIR" "$AGY_CONVERSATION_ID" > "$log_file"
cat > "$transcript_dir/transcript_full.jsonl" <<'JSONL'
{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command","args":{"CommandLine":"pwd"}}]}
{"step_index":2,"source":"MODEL","type":"RUN_COMMAND","status":"DONE","content":"Output:\\n/repo\\n"}
JSONL
sleep 1
printf "%s" "final answer"
`
    );
    const provider = new AgyProvider();
    const generator = provider.sendQuery('Run pwd', tmpRoot, undefined, {
      env: {
        AGY_APP_DATA_DIR: appDataDir,
        AGY_CONVERSATION_ID: conversationId,
      },
      assistantConfig: { agyBinaryPath: fakeAgy },
    });

    const first = await generator.next();
    expect(first.value).toEqual({
      type: 'tool',
      toolName: 'Run Command',
      toolInput: { CommandLine: 'pwd' },
      toolCallId: '1:0',
    });

    const second = await generator.next();
    expect(second.value).toEqual({
      type: 'tool_result',
      toolName: 'Run Command',
      toolOutput: 'Output:\n/repo\n',
      toolCallId: '1:0',
    });

    const rest: MessageChunk[] = [];
    for await (const chunk of generator) {
      rest.push(chunk);
    }
    expect(rest).toEqual([{ type: 'assistant', content: 'final answer' }, { type: 'result' }]);
  });
});

async function collect(generator: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of generator) {
    chunks.push(chunk);
  }
  return chunks;
}

function writeExecutable(name: string, content: string): string {
  const path = join(tmpRoot, name);
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}
