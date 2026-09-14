import { defineWorkflow } from "../src/index.js";

// Expected exit code 1. The first output survives the subsequent failure.
export default defineWorkflow(async ctx => {
  await ctx.step("Collect evidence", async () => {
    ctx.output("Evidence", { collected: true, task: ctx.task });
  });
  await ctx.step("Fail validation", () => ctx.exec([process.execPath, "-e", "console.error('Deliberate test failure'); process.exit(1)"]));
});
