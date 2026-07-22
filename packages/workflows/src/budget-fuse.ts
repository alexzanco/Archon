import type { MessageChunk } from '@archon/providers/types';

import type { NodeBudget } from './schemas/dag-node';

export type BudgetExceededWhich =
  | 'max_tool_calls'
  | 'max_tool_result_bytes'
  | 'max_single_tool_result_bytes'
  | 'max_wall_seconds'
  | 'forbidden_path_globs';

export class BudgetExceededError extends Error {
  readonly code: string;

  constructor(readonly which: BudgetExceededWhich) {
    super(`BUDGET_EXCEEDED:${which}`);
    this.name = 'BudgetExceededError';
    this.code = `BUDGET_EXCEEDED:${which}`;
  }
}

export interface BudgetFuseSnapshot {
  toolCalls: number;
  toolResultBytes: number;
  peakToolResultBytes: number;
}

/**
 * Observes provider-neutral chunks and exposes the first threshold crossing.
 * It is a spend fuse, not a sandbox: a transcript-derived path match is
 * necessarily observed after the underlying read has begun.
 */
export class BudgetFuse {
  private readonly reported = new Set<BudgetExceededWhich>();
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private triggered: BudgetExceededError | undefined;
  private toolCalls = 0;
  private toolResultBytes = 0;
  private peakToolResultBytes = 0;

  constructor(
    readonly budget: NodeBudget | undefined,
    private readonly onExceeded: (
      which: BudgetExceededWhich,
      enforcement: NodeBudget['enforcement']
    ) => void
  ) {
    if (budget?.max_wall_seconds !== undefined) {
      this.timer = setTimeout(() => {
        this.exceed('max_wall_seconds');
      }, budget.max_wall_seconds * 1000);
      this.timer.unref?.();
    }
  }

  observe(chunk: MessageChunk): BudgetExceededError | undefined {
    if (!this.budget || this.triggered) return this.triggered;
    if (chunk.type === 'tool') {
      this.toolCalls++;
      this.check('max_tool_calls', this.toolCalls, this.budget.max_tool_calls);
      const path = JSON.stringify(chunk.toolInput ?? {});
      if (this.matchesForbiddenPath(path)) this.exceed('forbidden_path_globs');
    } else if (chunk.type === 'tool_result') {
      const bytes = Buffer.byteLength(chunk.toolOutput, 'utf8');
      this.toolResultBytes += bytes;
      this.peakToolResultBytes = Math.max(this.peakToolResultBytes, bytes);
      this.check('max_single_tool_result_bytes', bytes, this.budget.max_single_tool_result_bytes);
      this.check('max_tool_result_bytes', this.toolResultBytes, this.budget.max_tool_result_bytes);
      if (this.matchesForbiddenPath(chunk.toolOutput)) this.exceed('forbidden_path_globs');
    }
    return this.triggered;
  }

  snapshot(): BudgetFuseSnapshot {
    return {
      toolCalls: this.toolCalls,
      toolResultBytes: this.toolResultBytes,
      peakToolResultBytes: this.peakToolResultBytes,
    };
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private check(
    which: Exclude<BudgetExceededWhich, 'forbidden_path_globs' | 'max_wall_seconds'>,
    actual: number,
    limit: number | undefined
  ): void {
    if (limit !== undefined && actual > limit) this.exceed(which);
  }

  private exceed(which: BudgetExceededWhich): void {
    if (!this.budget || this.reported.has(which)) return;
    this.reported.add(which);
    this.onExceeded(which, this.budget.enforcement);
    if (this.budget.enforcement === 'enforce' && !this.triggered) {
      this.triggered = new BudgetExceededError(which);
    }
  }

  private matchesForbiddenPath(value: string): boolean {
    return (this.budget?.forbidden_path_globs ?? []).some(pattern =>
      globToRegExp(pattern).test(value)
    );
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const source = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^\\s"\']*').replace(/\?/g, '.');
  return new RegExp(source);
}
