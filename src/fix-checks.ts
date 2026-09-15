import { defineWorkflow, z } from "./index.js";
import { validateAndRepair, commandSchema } from "./engineering.js";

export default defineWorkflow({ input: z.object({
  checks: z.array(commandSchema).min(1), prompt: z.string().default("Fix the failing checks."),
  maxRepairs: z.number().int().min(0).max(10).default(3),
}), async run(ctx) {
  await validateAndRepair(ctx, { task: ctx.input.prompt, checks: ctx.input.checks, maxRepairs: ctx.input.maxRepairs });
  ctx.output("Result", "All checks passed");
} });
