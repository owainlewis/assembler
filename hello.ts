import { defineWorkflow } from "./src/index.js";

export default defineWorkflow(async ctx => {
  await ctx.step("Check Git", () =>
    ctx.exec(["git", "status", "--short"]),
  );

  const result = await ctx.step("Explain project", () =>
    ctx.agent(
      "Read README.md and summarize this project in three sentences. Do not modify files.",
    ),
  );

  ctx.output("Project summary", result.stdout);
});
