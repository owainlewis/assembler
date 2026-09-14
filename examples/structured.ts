import { defineWorkflow, z } from "../src/index.js";

export default defineWorkflow(async ctx => {
  const result = await ctx.step("Classify", () => ctx.agentJson(
    `Classify the task as bug or feature, and give a one-sentence reason. Do not use tools.\n${ctx.task}`,
    z.object({ kind: z.enum(["bug", "feature"]), reason: z.string() }),
  ));
  ctx.output("Classification", result);
  await ctx.step(result.kind === "bug" ? "Bug workflow" : "Feature workflow", async () => {
    ctx.output("Next action", result.kind === "bug" ? "Write a reproducing test" : "Define acceptance criteria");
  });
});
