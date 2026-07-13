import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { MessageChunk } from '../../types';

interface AgyTranscriptStep {
  step_index?: unknown;
  type?: unknown;
  content?: unknown;
  tool_calls?: unknown;
}

interface AgyToolCall {
  name?: unknown;
  args?: unknown;
}

interface PendingToolCall {
  id: string;
  name: string;
}

interface TranscriptLocation {
  conversationId: string;
  transcriptPath: string;
}

const CONVERSATION_ID_PATTERN =
  /(?:Print mode: conversation=|Created conversation )([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const APP_DATA_DIR_PATTERN = /CLI app data directory: (.+)$/m;
const FALLBACK_APP_DATA_DIR = join(homedir(), '.gemini', 'antigravity-cli');
const TAIL_POLL_INTERVAL_MS = 250;

export async function readAgyToolChunksFromLog(logFilePath: string): Promise<MessageChunk[]> {
  const logText = await readTextIfExists(logFilePath);
  if (!logText) return [];

  const conversationId = extractConversationId(logText);
  if (!conversationId) return [];

  const appDataDir = extractAppDataDir(logText) ?? FALLBACK_APP_DATA_DIR;
  const transcriptPath = join(
    appDataDir,
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript_full.jsonl'
  );

  return readAgyToolChunksFromTranscript(transcriptPath);
}

export async function* tailAgyToolChunksFromLog(
  logFilePath: string,
  donePromise: Promise<unknown>
): AsyncGenerator<MessageChunk> {
  const parser = new AgyTranscriptToolParser();
  let location: TranscriptLocation | undefined;
  let offset = 0;
  let done = false;

  donePromise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    }
  );

  while (true) {
    if (!location) {
      const logText = await readTextIfExists(logFilePath);
      if (logText) {
        location = resolveTranscriptLocation(logText);
      }
    }

    if (location) {
      const next = await readNewTranscriptText(location.transcriptPath, offset);
      if (next) {
        offset = next.offset;
        for (const chunk of parser.parseText(next.text)) {
          yield chunk;
        }
      }
    }

    if (done) {
      if (!location) {
        const logText = await readTextIfExists(logFilePath);
        if (logText) {
          location = resolveTranscriptLocation(logText);
        }
      }
      if (location) {
        const finalRead = await readNewTranscriptText(location.transcriptPath, offset);
        if (finalRead) {
          for (const chunk of parser.parseText(finalRead.text)) {
            yield chunk;
          }
        }
      }
      return;
    }

    await sleep(TAIL_POLL_INTERVAL_MS);
  }
}

export async function readAgyToolChunksFromTranscript(
  transcriptPath: string
): Promise<MessageChunk[]> {
  const transcriptText = await readTextIfExists(transcriptPath);
  if (!transcriptText) return [];

  const parser = new AgyTranscriptToolParser();
  return parser.parseText(transcriptText);
}

class AgyTranscriptToolParser {
  private pending: PendingToolCall[] = [];
  private lineCarry = '';

  parseText(text: string): MessageChunk[] {
    const chunks: MessageChunk[] = [];
    const lines = `${this.lineCarry}${text}`.split(/\r?\n/);
    this.lineCarry = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const step = parseJsonObject(trimmed) as AgyTranscriptStep | undefined;
      if (!step) continue;

      const calls = parseToolCalls(step);
      for (const call of calls) {
        const id = `${stepIndexForId(step)}:${this.pending.length}`;
        this.pending.push({ id, name: call.name });
        chunks.push({
          type: 'tool',
          toolName: call.name,
          ...(call.input ? { toolInput: call.input } : {}),
          toolCallId: id,
        });
      }

      const resultContent = parseToolResult(step);
      if (resultContent === undefined) continue;

      const matchingCall = this.pending.shift();
      const toolName = matchingCall?.name ?? readableToolName(step.type);
      chunks.push({
        type: 'tool_result',
        toolName,
        toolOutput: resultContent,
        ...(matchingCall ? { toolCallId: matchingCall.id } : {}),
      });
    }

    return chunks;
  }
}

function resolveTranscriptLocation(logText: string): TranscriptLocation | undefined {
  const conversationId = extractConversationId(logText);
  if (!conversationId) return undefined;
  const appDataDir = extractAppDataDir(logText) ?? FALLBACK_APP_DATA_DIR;
  return {
    conversationId,
    transcriptPath: join(
      appDataDir,
      'brain',
      conversationId,
      '.system_generated',
      'logs',
      'transcript_full.jsonl'
    ),
  };
}

function extractConversationId(logText: string): string | undefined {
  return CONVERSATION_ID_PATTERN.exec(logText)?.[1];
}

function extractAppDataDir(logText: string): string | undefined {
  const raw = APP_DATA_DIR_PATTERN.exec(logText)?.[1]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function readNewTranscriptText(
  transcriptPath: string,
  offset: number
): Promise<{ text: string; offset: number } | undefined> {
  try {
    const text = await readFile(transcriptPath, 'utf8');
    if (text.length <= offset) return undefined;
    return { text: text.slice(offset), offset: text.length };
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseToolCalls(
  step: AgyTranscriptStep
): { name: string; input?: Record<string, unknown> }[] {
  if (!Array.isArray(step.tool_calls)) return [];

  const calls: { name: string; input?: Record<string, unknown> }[] = [];
  for (const rawCall of step.tool_calls) {
    if (!rawCall || typeof rawCall !== 'object') continue;
    const call = rawCall as AgyToolCall;
    if (typeof call.name !== 'string' || call.name.length === 0) continue;
    const input = isRecord(call.args) ? call.args : undefined;
    calls.push({
      name: readableToolName(call.name),
      ...(input ? { input } : {}),
    });
  }
  return calls;
}

function parseToolResult(step: AgyTranscriptStep): string | undefined {
  if (typeof step.type !== 'string') return undefined;
  if (!isToolResultStepType(step.type)) return undefined;
  return typeof step.content === 'string' ? step.content : '';
}

function isToolResultStepType(type: string): boolean {
  return (
    type === type.toUpperCase() &&
    ![
      'CHECKPOINT',
      'CONVERSATION_HISTORY',
      'EPHEMERAL_MESSAGE',
      'MODEL_RESPONSE',
      'PLANNER_RESPONSE',
      'USER_INPUT',
    ].includes(type)
  );
}

function readableToolName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) return 'unknown';
  return name
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function stepIndexForId(step: AgyTranscriptStep): string {
  if (typeof step.step_index === 'number' || typeof step.step_index === 'string') {
    return String(step.step_index);
  }
  return 'agy-tool';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
