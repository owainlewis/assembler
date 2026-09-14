import { defineWorkflow, z } from "../src/index.js";

// Publish only deliberately staged changes. No staging, force-push or merge bypass.
export default defineWorkflow({
  input: z.object({ message: z.string().trim().min(1) }),
  async run(ctx) {
    await ctx.step("Check branch and staged changes", async () => {
      const branch = (await ctx.exec(["git", "branch", "--show-current"])).stdout.trim();
      if (branch !== "main") throw new Error("This workflow publishes main only");
      await ctx.exec(["git", "diff", "--quiet"]);
      await ctx.exec(["git", "diff", "--cached", "--check"]);
      const staged = await ctx.exec(["git", "diff", "--cached", "--quiet"], { allowFailure: true });
      if (staged.exitCode !== 1) throw new Error("Expected deliberately staged changes to commit");
      await ctx.exec(["git", "fetch", "origin", "main"]);
      await ctx.exec(["git", "merge-base", "--is-ancestor", "origin/main", "HEAD"]);
      ctx.output("Staged changes", (await ctx.exec(["git", "diff", "--cached", "--stat"])).stdout);
    });
    await ctx.step("Typecheck", () => ctx.exec(["npm", "run", "check"]));
    await ctx.step("Tests", () => ctx.exec(["npm", "test"]));
    await ctx.step("Build", () => ctx.exec(["npm", "run", "build"]));
    await ctx.step("Commit", () => ctx.exec(["git", "commit", "-m", ctx.input.message]));
    await ctx.step("Push main", () => ctx.exec(["git", "push", "origin", "main"]));
    await ctx.step("Verify remote", async () => {
      const local = (await ctx.exec(["git", "rev-parse", "HEAD"])).stdout.trim();
      const remote = (await ctx.exec(["git", "ls-remote", "--heads", "origin", "refs/heads/main"])).stdout.trim().split(/\s+/)[0];
      if (remote !== local) throw new Error("Remote main does not match the published commit");
      ctx.output("Published commit", local);
    });
  },
});
