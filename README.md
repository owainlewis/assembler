# Assembler

**Coding workflows as code.** A small TypeScript CLI for your software factory.

```text
assembler · build · tasks/auth-refresh.md

✓ Implement                2m 41s
✓ Review                      34s
✗ Local checks                18s
✓ Repair 1                 1m 12s
✓ Verify 1                    16s
```

Assembler runs a procedure. Your coding agent does the reasoning. Use the built-in
build workflow or write an ordinary TypeScript function with named steps, command
execution, and agent calls. No provider SDK or agent-output parser required.

## Install

Node.js 22+ is required. This initial version is installed from source; it is not
published to npm yet.

```sh
git clone https://github.com/owainlewis/assembler.git
cd assembler
npm ci
npm run build
npm link
```

In the project you want to work on:

```sh
assembler init
# Set checks in assembler.json, then:
assembler run build --task tasks/auth-refresh.md
assembler run build --prompt "Fix the parser's empty-input handling"
assembler run build --task tasks/auth-refresh.md --agent claude
```

`--project` defaults to the current directory. Task paths and workflow paths are
resolved relative to that project. Use `--json` for a machine-readable success
result. Failures go to stderr and return exit code 1.

## Harnesses are commands

`assembler.json` is optional for custom workflows. `init` writes the defaults.
Add explicit validation commands before using the built-in build workflow:

```json
{
  "agent": "codex",
  "agents": {
    "codex": { "command": ["codex", "exec", "--sandbox", "workspace-write", "-"], "input": "stdin" },
    "claude": { "command": ["claude", "-p", "{prompt}"], "input": "argument" }
  },
  "checks": [["npm", "test"], ["npm", "run", "lint"]],
  "maxRepairs": 3,
  "timeoutMs": 1800000
}
```

Any executable can be a harness. Add another entry and select it with `--agent`.
For a Pi installation, configure its supported noninteractive invocation the same
way. There is no special Pi adapter or verified Pi preset in this release.

Commands are **argument arrays**, not shell strings. `{prompt}` is substituted as
literal argument text; quotes, dollar signs, and newlines never become shell code.
Prefer stdin for large or sensitive prompts; argv can be visible in process lists.
To deliberately execute shell syntax in a workflow use `ctx.exec(["sh", "-c", script])`.

Authenticate the harness separately. Its normal permissions apply; Assembler does
not bypass them. Configure appropriate noninteractive permissions in the harness
before unattended runs. Codex's preset uses its `workspace-write` sandbox; Claude's preset
leaves permission configuration to you.

## Write a workflow

Create `.assembler/workflows/audit.ts`:

```ts
// Type annotations are optional; no package import is needed for a plain function.
export default async function audit(ctx) {
  const diff = await ctx.step("Read changes", () =>
    ctx.exec(["git", "diff"]),
  );

  await ctx.step("Review", () =>
    ctx.agent(`Review these changes. Do not edit files.\n${diff.stdout}`),
  );

  await ctx.step("Tests", () => ctx.exec(["npm", "test"]));
}
```

```sh
assembler run audit --prompt "Review the current changes"
assembler run ./workflows/custom.ts --task task.md
```

For type checking, install this package into your workflow project and use:

```ts
import { defineWorkflow } from "@owainlewis/assembler";

export default defineWorkflow(async ctx => {
  await ctx.step("Implement", () => ctx.agent(ctx.task));
  await ctx.step("Verify", () => ctx.exec(["npm", "test"]));
});
```

The context exposes `task`, `project`, `config`, `signal`, `step`, `exec`, and
`agent`. Commands return `{ exitCode, stdout, stderr, log }`. Nonzero exits throw
unless `allowFailure: true` is supplied. Output returned in memory is limited to
the last 64,000 characters per stream; complete output is saved to disk.

Workflows are trusted local programs with your account's permissions. They can
import libraries, call APIs, branch, and loop. Keep external task content as data.
Named steps run as you call them; sequential steps provide the clearest v1 UI.

## Completion and recovery

An agent's zero exit code means its process succeeded, not that its claims are
correct. The built-in workflow requires explicit check commands and verifies again
after every repair, including the final allowed repair. Its fresh review invocation
can edit defects; it is not a structured independent approval gate.

Build works in the specified directory. Start from a branch or worktree you choose.
It does not automatically create worktrees, commit, open PRs, poll remote CI, or
merge. Those operations belong in custom workflows for now. Local files and inline
prompts are the task sources in v0.1; GitHub/Linear task fetching is not included.

Run records and command logs live under `.assembler/runs/<id>/`. Add that directory
to your project's `.gitignore`. Logs may contain private code or agent output.
Ctrl+C and command timeouts terminate subprocess groups on macOS/Linux. Windows
process-tree cancellation is not supported in v0.1. Custom async code must observe
`ctx.signal`; the timeout applies to subprocesses, not arbitrary workflow code.

Runs are inspectable but **not automatically resumable**. Rerunning a workflow
executes its steps again. Token metrics are intentionally absent rather than
inferred from unstructured output. Built-in workflows are released with the CLI.

## Development

```sh
npm ci
npm run check
npm test
npm run build
```

MIT licensed. Part of the [Machinist](https://github.com/owainlewis/machinist)
software factory: Assembler executes workflows; Machinist schedules the work.
