# Assembler

Coding workflows as code. A small TypeScript CLI for your software factory.

The workflow owns the procedure: fetch a ticket, run an agent, check its work,
review it, and iterate. The agent owns the reasoning. Switch coding agents without
rewriting the procedure.

## Install

Node.js 22+ is required. Install from source; this version is not published to npm.

```sh
git clone https://github.com/owainlewis/assembler.git
cd assembler
npm ci
npm run build
npm link
```

Install-script decisions are pinned in `package.json`: esbuild's binary installer
is approved; fsevents scripts are denied because its published package already
ships a native binary. New dependency versions need a fresh review. CI checks
`npm ci --strict-allow-scripts` on npm 12 on Linux and macOS; no blanket script
approval is required.

Authenticate Codex or Claude separately. Delivery also needs Git, `gh auth login`,
an `origin` remote for the current GitHub project, and push/PR permissions.

## Ticket → PR

In your target project, create `assembler.json`:

```json
{
  "agent": "codex",
  "workflows": {
    "build": {
      "prompt": "Build this task. Follow repository conventions, keep changes focused, and add regression tests.",
      "setup": [["npm", "ci"]],
      "checks": [["npm", "test"], ["npm", "run", "check"]]
    }
  }
}
```

Use commands that apply to your project. For Go, omit `setup` and use checks
such as `["go", "test", "./..."]` and `["go", "vet", "./..."]`.

```sh
assembler build --ticket https://github.com/owner/repo/issues/123
assembler build --ticket 123 --agent claude
assembler build --ticket ENG-123 --prompt "Build this. Preserve the public API."
```

The agent fetches the ticket through a CLI, not through an Assembler HTTP adapter
or MCP. GitHub uses `gh issue view`; Linear defaults to the community
[schpet/linear-cli](https://github.com/schpet/linear-cli) commands `linear issue view`
and `linear issue comment list`, with JSON output. Install and authenticate the
chosen CLI separately. Assembler does not perform login or read Linear API keys.
Linear accepts an identifier or issue URL; GitHub issues must belong to the selected
project. `--task` aliases `--ticket` on `build`; `--project` defaults to the current directory.

The fetch agent returns a structured snapshot: identifier, canonical URL, title,
description, comments and acceptance criteria. The workflow checks the identity,
active state, completeness and successful CLI calls recorded by the SDK, then saves
the snapshot for implementation and review. Missing CLI/authentication or incomplete
context stops delivery; there is no MCP or direct-HTTP fallback. Content extraction
remains an agent judgment, not a byte-for-byte completeness guarantee.

Test that exact step without editing code or opening a PR:

```sh
assembler run fetch-task --ticket 123
assembler run fetch-task --ticket 361 --input '{"repo":"owainlewis/neo"}' --agent claude
```

For another Linear CLI, override the workflow's trusted `linearCommands` argument
arrays, using `{ticket}` for the identifier. Include commands for both details and
comments. For example, set the following under `workflows.build` (or
`workflows.fetch-task` for the standalone workflow):

```json
{
  "linearCommands": [
    ["/path/to/linear", "issue", "view", "{ticket}", "--json"],
    ["/path/to/linear", "issue", "comment", "list", "{ticket}", "--json"]
  ]
}
```

Commands are trusted project configuration, never taken from ticket text. Configure
read operations only and prefer read-scoped CLI credentials for unattended fetching.

The delivery workflow:

1. Agent fetches via CLI; validate and save the task snapshot; claim a local per-ticket lock.
2. Create/reuse an isolated worktree on a stable branch such as `assembler/github-repo-123`.
3. Run setup, then pass the ticket and your prompt to the implementation agent.
4. Run local checks and a fresh, read-only code review. Repair findings and repeat.
5. Commit, push, and open a PR (or reuse the existing open PR).
6. Wait for CI and a quiet feedback window; assess comments and unresolved threads.
7. Repair feedback, repeat local checks/review, and push. Resolve unchanged review
   threads only after the repair passes validation and review.
8. Recheck the remote head, CI, review threads, required reviews and mergeability;
   publish a `Ready` result. **Never merge automatically.**

Setup runs on continuation too; keep it safe to repeat. The original checkout is
not switched or staged. Worktrees and PRs remain available when a gate stops work.

A schema-valid agent approval is still a judgment. `Ready` means the observed
gates passed for the reported commit, not that no future review can arrive.
Missing CI checks, drafts, conflicts, outstanding required approvals and unresolved
threads block it. Local agent review does not replace required GitHub approvals.

### Workflow-owned policy

Use `workflows.build` for project defaults, `--input-file delivery.json` or
`--input '{...}'` for an invocation. CLI input overrides defaults; `--prompt`
overrides the input prompt. Inputs are validated before the workflow runs.

Build owns `ticket`, `prompt`, `linearCommands`, `setup`, `checks`, `base`, `localRepairs`
(default 3), `feedbackRepairs` (3), `feedbackTimeoutMs` (20 minutes per round),
`pollMs` (30 seconds), and `reviewQuietMs` (60 seconds). Repair limits can be
zero. These are not runtime-wide settings. Old top-level `checks`/`maxRepairs`
config is rejected with a migration error.

`assembler run task-to-pr` runs the same implementation, using its own
`workflows.task-to-pr` defaults. `assembler build` uses `workflows.build`.

## Standard engineering examples

| Workflow | Pattern | Effects |
| --- | --- | --- |
| `build` / `task-to-pr` | Ticket → implement → review/repair → PR → feedback/repair → ready | Worktree, commits, PR and verified thread resolution |
| `fetch-task` | Agent runs ticket CLI → validate → save snapshot | Read operations only; same fetch step as build |
| `fix-checks` | Failing checks → repair → rerun checks | Edits current project; no commit/PR |
| `review-pr` | Fetch PR → review → independently verify findings | Report only; no published GitHub review/comment |

```sh
assembler run fix-checks --input '{"checks":[["npm","test"]],"maxRepairs":2}'
assembler run review-pr --input '{"pr":123}' --agent claude
```

The files in `examples/task-to-pr.ts`, `examples/fix-checks.ts`, and
`examples/review-pr.ts` are entry points to the same implementations, not
diverging copies. `examples/task-to-pr.input.json` shows delivery inputs.
Installed consumers can import through
`@owainlewis/assembler/workflows/task-to-pr`, `/fetch-task`, `/fix-checks`, and `/review-pr`.

Smaller `outputs.ts`, `structured.ts`, `parallel.ts` and `failure.ts` examples
exercise output, branching, concurrent-step and failure contracts.

## Write a TypeScript workflow

Install this package in your workflow project for imports and type checking.
Create `.assembler/workflows/implement.ts`:

```ts
import { defineWorkflow, z } from "@owainlewis/assembler";

export default defineWorkflow({
  input: z.object({ prompt: z.string().min(1) }),
  async run(ctx) {
    const implementation = await ctx.agent("Implement", {
      prompt: ctx.input.prompt,
    });
    ctx.output("Implementation", implementation.text);

    await ctx.step("Tests", () => ctx.exec(["npm", "test"]));

    const review = await ctx.agent("Review", {
      readOnly: true,
      prompt: "Review the current changes for correctness. Do not edit files.",
      schema: z.object({ approved: z.boolean(), findings: z.array(z.string()) }),
    });
    ctx.output("Review", review.data);
    if (!review.data.approved) throw new Error("Review found problems");
  },
});
```

```sh
assembler run implement --prompt "Fix empty-input handling and add a regression test"
assembler run ./workflows/custom.ts --input-file inputs.json --agent claude
```

`ctx.agent(name, options)` is already a progress step. It returns `text`,
typed `data` when a schema is supplied, and provider-reported `usage` and
`sessionId` when available. Each call starts a fresh session. Pass `agent`
in a step's options to select another configured SDK agent.

Use normal loops/conditions for policy and `Promise.all` for independent steps.
`ctx.at(worktree)` scopes commands/agents while sharing parsed inputs, progress
and artifacts. Concurrent editing needs separate worktrees. Workflows are trusted
programs, not a security sandbox.

`ctx.exec` takes an argument array and returns exit code, stdout/stderr tails,
truncation flags and a full log path. Nonzero exits throw unless
`{ allowFailure: true }` is explicit. Legacy function workflows, `ctx.task`,
`ctx.agent(prompt)` and `ctx.agentJson(prompt, schema)` remain compatible;
new examples use typed inputs and named calls.

## Agent integrations

Codex and Claude use official coding-agent SDKs by default. These drive the coding
harnesses; they are not raw model API replacements. Credentials, tools and provider
permissions still apply. No silent fallback or hidden Assembler retries.

```json
{
  "agent": "codex",
  "agents": {
    "codex": { "provider": "codex" },
    "claude": { "provider": "claude" },
    "custom": {
      "provider": "command",
      "command": ["my-agent", "--prompt", "{prompt}"],
      "input": "argument"
    }
  },
  "timeoutMs": 1800000
}
```

SDK defaults work without config. Entries may set `model` and `executable`.
Codex uses workspace-write (read-only for review), with no interactive approvals.
Claude uses accept-edits, or restricted Read/Glob/Grep tools for read-only steps.
Configure permitted noninteractive shell operations in Claude settings when needed;
Assembler does not bypass permissions. Trusted setup/check commands run separately
under your account.

Read-only agent steps can explicitly supply `readCommands` for CLI fetching.
Claude exposes Bash with a hook allowing only those exact commands and disables
inherited MCP connections for that step. Codex selects a read-only filesystem
permission profile with network access; this requires a recent Codex supporting
named permission profiles. The Codex sandbox does not restrict remote API methods:
read-scoped credentials and trusted commands still matter. Code-review steps keep
their existing local read-only behavior. Raw tool events remain in private run logs.

Generic commands are explicit opt-ins: literal argument arrays or stdin, without
shell interpolation. They provide no guarantees about tools, usage or final-answer
extraction. Read-only review steps reject them. There is no verified Pi preset.
Native CLI `structured` adapters (`codex`/`claude`) remain for explicit command
configurations; ordinary commands must emit pure JSON for schema-backed calls.

## Outputs and recovery

`ctx.output(name, value)` publishes a named text/JSON artifact. The terminal
shows progress followed by all published outputs, including those saved before
failure. Long values get a preview and artifact path; provider streams stay in logs.

Use `--json` for a final versioned record or `--events` for ordered NDJSON.
Human progress goes to stderr; named outputs go to stdout. Failures exit 1;
cancellations exit 130. Prefer `ctx.output` over console logging.

Records, events, outputs and SDK/command logs live in `.assembler/runs/<id>/`.
Ignore it in Git and treat it as private. SDK session IDs and reported token usage
appear in `agent.finished` events. Command adapters do not invent those metrics.

Build continuation reuses a matching worktree/open PR, reruns local validation,
and reassesses feedback for the current commit. Locks and feedback state live in
`assembler/` under the repository's common Git directory. A stale crash lock
requires confirming the old process stopped before removing that task's lock.
Divergent local/remote heads require reconciliation. Closed/merged PRs are not
automatically reopened. This is not durable replay or distributed claiming.

Large diffs and review-thread pagination beyond the supported limit fail explicitly.
The fetch agent must report blocked if CLI output is incomplete or truncated.
The review quiet window is bounded, not a permanent PR monitor.
Linear fetching does not update ticket statuses. Windows process-tree cancellation
is unsupported. Use an outer supervisor deadline for unattended runs; custom async
code must observe `ctx.signal`.

## Development

```sh
npm ci
npm run check
npm test
npm run build
```

Tests simulate delivery/repair/continuation, readiness gates and Linear responses,
and exercise real subprocesses, schemas and output protocols. They do not create
real issues or PRs. Live provider checks require credentials.

MIT licensed. Part of the [Machinist](https://github.com/owainlewis/machinist)
software factory: Assembler executes workflows; Machinist schedules work.
