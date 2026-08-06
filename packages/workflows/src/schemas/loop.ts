/**
 * Zod schema for loop node configuration.
 */
import { z } from '@hono/zod-openapi';

export const loopNodeConfigSchema = z
  .object({
    /** Inline prompt text executed each iteration. */
    prompt: z.string().min(1, "loop node requires 'loop.prompt' (non-empty string)").optional(),
    /** Named command loaded from .archon/commands/<name>.md. */
    command: z.string().min(1, "loop node requires 'loop.command' (non-empty string)").optional(),
    /** Completion signal string detected in AI output (e.g., "COMPLETE"). */
    until: z
      .string()
      .min(1, "loop node requires 'loop.until' (completion signal string)")
      .optional(),
    /** Maximum iterations allowed; exceeding this fails the node. */
    max_iterations: z.number().int().positive("'loop.max_iterations' must be a positive integer"),
    /** Whether to start fresh session each iteration (default: false). */
    fresh_context: z.boolean().default(false),
    /**
     * Optional bash script run after each iteration. Exit 0 completes the loop,
     * exit 1 requests another iteration, and any other exit fails the loop.
     */
    until_bash: z.string().optional(),
    /** When true, pause between iterations for user input via /workflow approve. */
    interactive: z.boolean().optional(),
    /** Message shown to user when paused (required when interactive is true). */
    gate_message: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if ((data.prompt === undefined) === (data.command === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "loop node requires exactly one of 'loop.prompt' or 'loop.command'",
        path: ['prompt'],
      });
    }
    if (data.until === undefined && data.until_bash === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "loop node requires 'loop.until' or 'loop.until_bash' (completion condition)",
        path: ['until'],
      });
    }
    if (data.interactive === true && !data.gate_message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "interactive loop requires 'loop.gate_message' (non-empty string)",
        path: ['gate_message'],
      });
    }
  });

export type LoopNodeConfig = z.infer<typeof loopNodeConfigSchema>;
