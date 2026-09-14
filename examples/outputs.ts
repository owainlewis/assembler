import { defineWorkflow, z } from "../src/index.js";

export default defineWorkflow(async ctx => {
  const summary = await ctx.step("Summarize task", () =>
    ctx.agent(`Summarize this task in one sentence. Do not use tools or modify files.\n${ctx.task}`));
  ctx.output("Summary", summary.stdout);

  const plan = await ctx.step("Structured plan", () => ctx.agentJson(
    `Give exactly two short implementation steps for this task. Do not use tools.\n${ctx.task}`,
    z.object({ steps: z.array(z.string()).length(2) }),
  ));
  ctx.output("Plan", plan);

  const review = await ctx.step("Review plan", () => ctx.agent(
    `Review this plan in two sentences. Do not use tools or modify files.\n${JSON.stringify(plan)}`));
  ctx.output("Review", review.stdout);
});
