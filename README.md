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
execution, and agent calls. Text steps use ordinary commands; structured steps use
native Codex/Claude JSON contracts with local schema validation.

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
result including named outputs and failures. Use `--events` for versioned NDJSON
progress events. These flags are mutually exclusive. Failed runs return exit code 1;
cancelled runs return 130. Human progress goes to stderr and outputs to stdout.

## Harnesses are commands

`assembler.json` is optional for custom workflows. `init` writes the defaults.
Add explicit validation commands before using the built-in build workflow:

```json
{
  "agent": "codex",
  "agents": {
    "codex": { "command": ["codex", "exec", "--sandbox", "workspace-write", "-"], "input": "stdin", "structured": "codex" },
    "claude": { "command": ["claude", "-p", "{prompt}"], "input": "argument", "structured": "claude" }
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

  const review = await ctx.step("Review", () =>
    ctx.agent(`Review these changes. Do not edit files.\n${diff.stdout}`),
  );
  ctx.output("Review", review.stdout);

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
`agent`, `agentJson`, and `output`. Commands return `{ exitCode, stdout, stderr, log,
stdoutTruncated, stderrTruncated }`. Nonzero exits throw
unless `allowFailure: true` is supplied. Output returned in memory is limited to
the last 64,000 characters per stream; complete output is saved to disk.

Workflows are trusted local programs with your account's permissions. They can
import libraries, call APIs, branch, and loop. Keep external task content as data.
Named steps run as you call them. Parallel steps work with `Promise.all`; each has
a unique ID, and outputs inside a step retain its ID even when steps finish out of
order. Await every step. Concurrent editing still requires workflow-level isolation.

## Outputs and structured decisions

```ts
import { defineWorkflow, z } from "@owainlewis/assembler";

export default defineWorkflow(async ctx => {
  const decision = await ctx.step("Classify", () => ctx.agentJson(
    `Classify this task: ${ctx.task}`,
    z.object({ kind: z.enum(["bug", "feature"]), reason: z.string() }),
  ));
  ctx.output("Classification", decision);
  if (decision.kind === "bug") {
    // Run your bug-specific workflow steps here.
  }
});
```

`ctx.output(name, value)` saves text or JSON immediately. The terminal displays
outputs below the finished progress display, including on failure. Long outputs
get a preview and a path to the full artifact. JSON results include all named
outputs. Use this instead of `console.log` for workflow results; ordinary console
messages are redirected to stderr so they do not corrupt the JSON protocol.
Direct writes to `process.stdout` from trusted workflow code can still break it.

`agentJson` uses Codex `--output-schema` plus `--output-last-message`, or Claude
`--json-schema --output-format json`. Schemas are draft-7 for compatibility.
Assembler validates the final value locally with Zod. Custom harnesses without a
`structured` adapter receive a JSON-only prompt and must emit valid JSON on stdout.
Malformed, truncated, fenced, or schema-invalid output fails the step; there are no
hidden Assembler retry calls. Provider-internal structured-output retries may occur.
Do not configure conflicting JSON output flags in the base harness command.

Try the checked-in workflows:

```sh
node dist/cli.js run examples/outputs.ts --prompt "Add a health endpoint" --agent codex
node dist/cli.js run examples/outputs.ts --prompt "Add a health endpoint" --agent claude
node dist/cli.js run examples/structured.ts --prompt "Fix a parser crash" --json
node dist/cli.js run examples/parallel.ts --prompt test
node dist/cli.js run examples/failure.ts --prompt test --json
node dist/cli.js run examples/parallel.ts --prompt test --events
```

The last two examples exercise failure and streaming protocols without agents.
`failure.ts` deliberately exits 1 while preserving its earlier output.

## Completion and recovery

An agent's zero exit code means its process succeeded, not that its claims are
correct. The built-in workflow requires explicit check commands and verifies again
after every repair, including the final allowed repair. Its fresh review invocation
can edit defects; it is not a structured independent approval gate.

Build works in the specified directory. Start from a branch or worktree you choose.
It does not automatically create worktrees, commit, open PRs, poll remote CI, or
merge. Those operations belong in custom workflows for now. Local files and inline
prompts are the task sources in v0.1; GitHub/Linear task fetching is not included.

Run records, `events.jsonl`, named artifacts and command logs live under
`.assembler/runs/<id>/`. Run records are replaced atomically; each final result and
event has `schemaVersion: 1`. Add that directory
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
