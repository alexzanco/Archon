import { describe, expect, test } from 'bun:test';

import { BudgetFuse } from './budget-fuse';

describe('BudgetFuse', () => {
  test('enforces every live transcript threshold with a typed error', () => {
    const cases = [
      [{ max_tool_calls: 0 }, { type: 'tool', toolName: 'Read' }, 'max_tool_calls'],
      [
        { max_single_tool_result_bytes: 2 },
        { type: 'tool_result', toolName: 'Read', toolOutput: 'abc' },
        'max_single_tool_result_bytes',
      ],
      [
        { max_tool_result_bytes: 2 },
        { type: 'tool_result', toolName: 'Read', toolOutput: 'abc' },
        'max_tool_result_bytes',
      ],
      [
        { forbidden_path_globs: ['**/secret/**'] },
        { type: 'tool', toolName: 'Read', toolInput: { path: '/tmp/secret/a' } },
        'forbidden_path_globs',
      ],
    ] as const;

    for (const [budget, chunk, which] of cases) {
      const seen: string[] = [];
      const fuse = new BudgetFuse({ enforcement: 'enforce', ...budget }, value => seen.push(value));
      const error = fuse.observe(chunk);
      expect(error?.message).toBe(`BUDGET_EXCEEDED:${which}`);
      expect(seen).toEqual([which]);
      fuse.dispose();
    }
  });

  test('reports without aborting in report mode', () => {
    const seen: string[] = [];
    const fuse = new BudgetFuse(
      { enforcement: 'report', max_tool_calls: 0 },
      (which, enforcement) => seen.push(`${enforcement}:${which}`)
    );
    expect(fuse.observe({ type: 'tool', toolName: 'Read' })).toBeUndefined();
    expect(seen).toEqual(['report:max_tool_calls']);
    fuse.dispose();
  });

  test('enforces the wall-clock budget without waiting for another chunk', async () => {
    const seen: string[] = [];
    const fuse = new BudgetFuse({ enforcement: 'enforce', max_wall_seconds: 0.01 }, which =>
      seen.push(which)
    );
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(seen).toEqual(['max_wall_seconds']);
    // The callback is what aborts the provider child; a subsequent stream
    // chunk exposes the same typed error to the executor.
    expect(fuse.observe({ type: 'system', content: 'tick' })?.message).toBe(
      'BUDGET_EXCEEDED:max_wall_seconds'
    );
    fuse.dispose();
  });
});
