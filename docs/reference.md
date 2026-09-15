# Assembler

`ctx.output(name, value, { detail: true })` saves diagnostic artifacts without
printing them in the default result. `--verbose`, `--json` and `runs show <id>`
include them. Normal outputs remain visible by default.

Throw `WorkflowBlocked` (exported by Assembler) for a task that needs user input
or cannot proceed. It produces terminal status `blocked`, preserves the reason
and outputs, and exits nonzero. Ordinary errors remain `failed`.

Detailed reference. For installation and a short introduction, see the
[README](../README.md). For queueing, cancellation and inspecting saved results,
see [background runs](runs.md).

Coding workflows as code. A small TypeScript CLI for your software factory.

The workflow owns the procedure: fetch a ticket, run an agent, check its work,
review it, and iterate. The agent owns the reasoning. Switch coding agents without
rewriting the procedure.

## SDKs run the agents. CLIs are their tools.

There are three separate parts:

- **Assembler CLI:** the command you run, such as `assembler run examples/fix-checks.ts`.
- **Coding-agent SDKs:** Assembler calls `@openai/codex-sdk` or
  `@anthropic-ai/claude-agent-sdk` to run the agent and receive structured results
  and events. These are the default integrations.
- **Ticket CLIs:** the agent runs `gh` or `linear` to fetch task context. Git and
  check commands also run as explicit workflow steps.

Using a CLI to fetch a ticket does **not** mean Assembler launches the coding agent
with a hand-built `claude -p` or `codex exec` command. The official SDK manages the
underlying coding harness. A custom command adapter is optional, not the default.

## One example: fix failing tests, then prove they pass

You could prompt an agent: “Fix the tests. Rerun them after each change. Stop after
two attempts.” A workflow puts that procedure in code:

```sh
assembler run examples/fix-checks.ts \
  --input '{"checks":[["npm","test"]],"maxRepairs":2}' \
  --agent codex
```

The [example workflow](../examples/fix-checks.ts) runs `npm test` and reads its exit code.
If it fails, the agent gets the failure output and repairs the code. The workflow
then runs the tests again—even after the last allowed repair.

- **The agent decides how to fix the code.**
- **The code decides whether checks passed, whether to retry, and when to stop.**

Already-green tests require no agent call. Remaining failures after two repairs
produce a failed run, not a success message. Repeated identical failure diagnostics
also stop the loop. Every check and repair appears in the run history.

An agent can follow the same procedure from a prompt. The benefit of code is that
the stopping rules are explicit and testable, and success depends on a fresh check
result—not on the agent remembering the procedure or claiming it finished.
Passing tests still only proves what those tests cover.

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
    "examples/task-to-pr.ts": {
      "prompt": "Build this task. Follow repository conventions, keep changes focused, and add regression tests.",
      "reviewPrompt": "Run OCR using the repository's documented invocation. Investigate and fix valid findings, then rerun. Report blocked if the tool cannot run.",
      "setup": [["npm", "ci"]],
      "checks": [["npm", "test"], ["npm", "run", "check"]]
    }
  }
}
```

Use commands that apply to your project. For Go, omit `setup` and use checks
such as `["go", "test", "./..."]` and `["go", "vet", "./..."]`.

```sh
assembler run examples/task-to-pr.ts --ticket https://github.com/owner/repo/issues/123
assembler run examples/task-to-pr.ts --ticket 123 --agent claude
assembler run examples/task-to-pr.ts --ticket ENG-123 --prompt "Build this. Preserve the public API."
```

The SDK-managed agent fetches tickets using command-line tools, not a built-in
tracker HTTP client or MCP. GitHub uses `gh issue view`; Linear defaults to the community
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
assembler run examples/fetch-task.ts --ticket 123
assembler run examples/fetch-task.ts --ticket 361 --input '{"repo":"owainlewis/neo"}' --agent claude
```

For another Linear CLI, override the workflow's trusted `linearCommands` argument
arrays, using `{ticket}` for the identifier. Include commands for both details and
comments. For example, set the following under `workflows["examples/task-to-pr.ts"]` (or
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
4. An agent reviews and repairs using `reviewPrompt`. Code runs configured checks;
   failures go directly to a repair agent and are checked again, up to `localRepairs`.
5. An agent writes the PR description using the review report and actual validation
   evidence. Code commits, pushes, and opens a PR (or reuses the existing open PR).
6. Wait for CI and a quiet feedback window. If CI is green and there is no new
   feedback, no feedback agent is needed.
7. One agent investigates and addresses new feedback/failed CI, then code validates
   and pushes repairs. It receives local validation evidence and CI results for the
   current candidate, not a fresh instruction to implement the whole task. Positive
   feedback needs no edits or repeated checks. Missing tools block only when needed
   to investigate or repair outstanding feedback; passing workflow checks are not
   invalidated by an unnecessary retry inside the agent sandbox.
   Only thread IDs explicitly reported as fixed are eligible
   for resolution, after successful checks and a new commit, if their content is
   unchanged. Agent-reported resolution remains a judgment, not independent proof.
8. Recheck the remote head, CI, review threads, required reviews and mergeability;
   publish a `Ready` result. **Never merge automatically.**

Setup runs on continuation too; keep it safe to repeat. The original checkout is
not switched or staged. Worktrees and PRs remain available when a gate stops work.
Dirty delivery worktrees are refused before setup or editing: inspect and reconcile
retained changes before rerunning. This is safe continuation, not automatic crash recovery.

`reviewPrompt` is optional; the default asks for review and repair using repository
conventions and prescribed tools. Configure OCR instructions if you use OCR; it
must already be available to the agent. Tool failures should be reported as blocked.
The workflow does not parse OCR output or promise an independent reviewer approval.
Each agent step currently starts a fresh harness session and receives explicit task
context; it is not a resumed implementation session.

Local check artifacts retain command arrays, exit codes, captured output, truncation
flags and full-log paths. Delivery binds successful checks to a Git tree before
publication and refuses code changes during validation or PR-description generation.
Checks should be non-mutating; put formatters and generators in setup or agent work.
After remote repairs, fresh check evidence remains in run logs; the initial PR body
is not automatically rewritten to claim newer evidence.

A schema-valid agent approval is still a judgment. `Ready` means the observed
gates passed for the reported commit, not that no future review can arrive.
Missing CI checks, drafts, conflicts, outstanding required approvals and unresolved
threads block it. Local agent review does not replace required GitHub approvals.

### Workflow-owned policy

Use `workflows["examples/task-to-pr.ts"]` for project defaults, `--input-file delivery.json` or
`--input '{...}'` for an invocation. CLI input overrides defaults; `--prompt`
overrides the input prompt. Inputs are validated before the workflow runs.

Build owns `ticket`, `prompt`, `reviewPrompt`, `linearCommands`, `setup`, `checks`, `base`, `localRepairs`
(default 3), `feedbackRepairs` (1), `feedbackTimeoutMs` (20 minutes per round),
`pollMs` (30 seconds), and `reviewQuietMs` (60 seconds). Repair limits can be
zero. Set `feedbackRepairs: 3` explicitly to retain the former default. These are not runtime-wide settings. Old top-level `checks`/`maxRepairs`
config is rejected with a migration error.

Defaults are keyed by the exact workflow argument. Use `examples/task-to-pr.ts`
when invoking that path, or your project-local registration name when using a short name.

## Standard engineering examples

| Workflow | Pattern | Effects |
| --- | --- | --- |
| `task-to-pr.ts` | Ticket → implement → review/repair → checks → PR → feedback/repair → ready | Worktree, commits, PR and explicitly reported thread resolution |
| `fetch-task` | Agent runs ticket CLI → validate → save snapshot | Read operations only; same fetch step as build |
| `fix-checks` | Failing checks → repair → rerun checks | Edits current project; no commit/PR |
| `review-pr` | Fetch PR → review → independently verify findings | Report only; no published GitHub review/comment |

```sh
assembler run examples/fix-checks.ts --input '{"checks":[["npm","test"]],"maxRepairs":2}'
assembler run examples/review-pr.ts --input '{"pr":123}' --agent claude
```

The workflow implementations live in `examples/`; shared engineering helpers live
in `examples/lib/`. They import only the generic runner API from `src/index.ts`.
Copy and adapt the examples in your project. `examples/task-to-pr.input.json` shows
delivery inputs. Workflow-specific package exports and the old `assembler build`
shortcut have been removed; use `assembler run <path>` or a project registration.

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

    const review = await ctx.agent("Review and repair", {
      prompt: `Review and repair this task: ${ctx.input.prompt}. Use repository review tools. Do not commit or push. Report blocked if required tools are unavailable.`,
      schema: z.object({ status: z.enum(["completed", "blocked"]), summary: z.string() }),
    });
    ctx.output("Review", review.data);
    if (review.data.status === "blocked") throw new Error(review.data.summary);
    const tests = await ctx.step("Tests", () => ctx.exec(["npm", "test"]));
    ctx.output("Validation evidence", tests);
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

`--agent codex` selects the Codex SDK; `--agent claude` selects the Claude Agent
SDK. No custom shell command is needed for either. These SDKs manage coding
harnesses, not just raw model API calls. Their authentication and permissions
still apply, and Assembler never silently switches to a command adapter on failure.

```json
{
  "agent": "codex",
  "agents": {
    "codex": { "provider": "codex" },
    "claude": { "provider": "claude" }
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

### Optional: other coding harnesses

Only use `provider: "command"` when you deliberately want a custom executable
instead of an SDK integration:

```json
{
  "provider": "command",
  "command": ["my-agent", "--prompt", "{prompt}"],
  "input": "argument"
}
```

Add it under a name in `agents` and select that name with `--agent`. Commands use
literal argument arrays or stdin, without shell interpolation. They do not provide
SDK guarantees about tools, usage or final-answer extraction. Read-only review
steps reject them. There is no verified Pi preset. Legacy CLI structured adapters
remain available for explicit command configurations; they are not the defaults.

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
