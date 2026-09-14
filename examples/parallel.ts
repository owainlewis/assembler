import { defineWorkflow } from "../src/index.js";

// No agent or credentials required. Steps deliberately finish out of order.
export default defineWorkflow(async ctx => {
  await Promise.all([600, 100, 300].map((delay, index) =>
    ctx.step(`Check ${index + 1}`, async () => {
      const result = await ctx.exec([process.execPath, "-e", `setTimeout(() => console.log('Check ${index + 1} passed'), ${delay})`]);
      ctx.output(`Result ${index + 1}`, result.stdout.trim());
    }),
  ));
});
