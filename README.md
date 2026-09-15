# Assembler

## What is it?

**A CLI for running coding-agent workflows written in TypeScript.**

You write the workflow. Assembler runs it, shows progress, saves outputs and logs,
and lets you inspect or cancel background runs.

Use agents for coding and judgment. Use ordinary code for setup, checks, execution
limits, and cleanup. No separate configuration language for defining workflow steps.

## What is a workflow—and why care?

A workflow is an async TypeScript function that combines agent calls, commands,
and your own code into a repeatable development process.

For a simple question, use your agent directly. A workflow becomes useful when
the surrounding execution matters. For example:

- Create a fresh gVisor container and clone the repository.
- Give an agent a coding task.
- Check the result and save its output.
- Remove the container and checkout afterward.

That gives each task its own environment without touching your working directory.
You can run it again—or run several tasks in parallel—without manually managing
checkouts. Isolation prevents shared-checkout conflicts, not conflicts between PRs.

The workflow owns the process. The agent decides how to solve the task.

## Example: implement a change, then check it

A complete workflow, from [examples/implement-and-check.ts](examples/implement-and-check.ts):

```ts
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
```

From this checkout:

```sh
assembler run examples/implement-and-check.ts \
  --prompt "Fix empty-input handling in the parser and add a regression test."
```

Illustrative terminal output:

```text
assembler · examples/implement-and-check.ts · assembler

✓ Implement                42s
✓ Run tests                8s

Result
Fixed empty-input handling and added a regression test.

Checks
npm test passed

Completed · <run-id>
Details: assembler runs show <run-id>
Logs: assembler runs logs <run-id> --follow
```

If tests fail, the run fails and retains the diagnostics. This small example edits
the current checkout; it does not create a PR or provide a sandbox. The relative
import is for the source checkout; the package API is `@owainlewis/assembler` when
installed as a project dependency.

Need more? Use normal TypeScript: functions, `if`, `try/finally`, npm libraries,
and `Promise.all`. Prompts can live in Markdown files loaded with `readFile`.
[Workflow API](docs/reference.md#write-a-typescript-workflow).

**The same idea, with gVisor.** These repository examples handle the environment
around the agent:

```sh
# Review a fresh clone; save the answer and patch, then clean up.
assembler run gvisor-task \
  --prompt "Review cancellation handling. Report concrete bugs. Do not edit files."

# Start from main; implement, review, test, open a PR and handle CI.
assembler run sandbox-delivery \
  --prompt "Fix issue #123 and add regression tests." \
  --input '{"githubAuth":"gh"}'
```

Replace `123` with a real issue in the selected repository. The repository defaults
to the current project's GitHub `origin`; local edits are not included.
Delivery verifies the PR's current commit, CI and GitHub review gates. It never
merges. Logs and patches are retained; unfinished work is preserved for inspection.

These examples require Linux, Docker with `runsc`, and an authenticated standalone
Codex executable. Their short names are registered in this checkout, not globally.
`githubAuth: "gh"` explicitly shares your GitHub login's full token permissions
with the sandbox; a repository-scoped token is safer.
[Sandbox setup and workflow source](examples/gvisor/README.md).

Add `--detach` on Linux to get a run ID back immediately:

```sh
assembler runs list
assembler runs show <run-id>
assembler runs logs <run-id> --follow
assembler runs cancel <run-id>
```

## Get started

**Install from source today** with Node.js 22+:

```sh
git clone https://github.com/owainlewis/assembler.git
cd assembler
npm ci
npm run build
npm link
assembler --help
```

**Downloadable releases:** [self-contained packaging](docs/binaries.md) includes
Node and dependencies, with a per-user installer. The first GitHub release has
not been published yet; neither has the npm package.

Authenticate your agent separately. Ordinary `ctx.agent()` calls use the official
Codex or Claude SDKs (`--agent codex` / `--agent claude`). The gVisor examples run
the Codex CLI inside the container instead. Workflows themselves are trusted code
running on the host; arbitrary TypeScript is not automatically sandboxed.

[API reference](docs/reference.md) · [Background runs](docs/runs.md) ·
[gVisor guide](examples/gvisor/README.md) · [Release installation](docs/binaries.md)

MIT licensed. Part of [Machinist](https://github.com/owainlewis/machinist).
