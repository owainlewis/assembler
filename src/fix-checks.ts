import { defineWorkflow, z } from "./index.js";
import { checks, commandSchema, instructions } from "./engineering.js";

export default defineWorkflow({ input: z.object({
  checks: z.array(commandSchema).min(1), prompt: z.string().default("Fix the failing checks."),
  maxRepairs: z.number().int().min(0).max(10).default(3),
}), async run(ctx) {
  let previous = "";
  for (let attempt = 0; attempt <= ctx.input.maxRepairs; attempt++) {
    const failures = await checks(ctx, ctx.input.checks, `Checks ${attempt + 1}`);
    if (!failures.length) { ctx.output("Result", "All checks passed"); return; }
    // Compare diagnostics, not changing log paths, to detect a stalled loop.
    const fingerprint = JSON.stringify(failures.map(failure => { const { log, ...value } = JSON.parse(failure); return value; }));
    if (attempt === ctx.input.maxRepairs) throw new Error("Check repair budget exhausted");
    if (fingerprint === previous) throw new Error("Check repair made no progress");
    previous = fingerprint;
    await ctx.agent(`Repair ${attempt + 1}`, { prompt: `${instructions}${ctx.input.prompt}\n${failures.join("\n")}` });
  }
} });
