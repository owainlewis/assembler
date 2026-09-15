import { defineWorkflow, z } from "../src/index.js";

export default defineWorkflow({
  input: z.object({ prompt: z.string().min(1) }),
  async run(ctx) {
    const result = await ctx.agent("Implement", {
      prompt: ctx.input.prompt,
    });

    await ctx.step("Run tests", () => ctx.exec(["npm", "test"]));

    ctx.output("Result", result.text);
    ctx.output("Checks", "npm test passed");
  },
});
