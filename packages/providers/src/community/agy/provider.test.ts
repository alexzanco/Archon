import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';

import type { MessageChunk, SendQueryOptions } from '../../types';
import { AgyProvider } from './provider';

const tmpRoot = mkdtempSync(join(tmpdir(), 'archon-agy-provider-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('AgyProvider', () => {
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
