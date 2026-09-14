import { defineWorkflow, z } from "../src/index.js";

export default defineWorkflow({ input: z.object({ prompt: z.string().min(1) }), async run(ctx) {
  const summary = await ctx.agent("Summarize task", {
    prompt: `Summarize this task in one sentence. Do not use tools or modify files.\n${ctx.input.prompt}` });
  ctx.output("Summary", summary.text);

  const plan = await ctx.agent("Structured plan", {
    prompt: `Give exactly two short implementation steps for this task. Do not use tools.\n${ctx.input.prompt}`,
    schema: z.object({ steps: z.array(z.string()).length(2) }),
  });
  ctx.output("Plan", plan.data);

  const review = await ctx.agent("Review plan", {
    prompt: `Review this plan in two sentences. Do not use tools or modify files.\n${JSON.stringify(plan.data)}` });
  ctx.output("Review", review.text);
} });
