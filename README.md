# Assembler

Your development workflows as code. Agents implement and repair; TypeScript owns
the checks, publishing and stopping rules.

Use it when a coding task needs explicit checks, bounded repair loops, isolated
environments, or several agent steps. For a one-off question, a prompt is enough.

## Install

Node.js 22+. Install from source (this version is not published to npm):

```sh
git clone https://github.com/owainlewis/assembler.git
cd assembler
npm ci
npm run build
npm link
```

Authenticate your coding agent separately. Codex and Claude use their official
coding-agent SDKs by default: `--agent codex` or `--agent claude`.
Tools such as `gh` and `linear` are commands the agent can use, not replacement
agent integrations. A custom command adapter is optional.

## One command, from ticket to PR

Add your project's commands to `assembler.json`:

```json
{
  "workflows": {
    "build": {
      "setup": [["npm", "ci"]],
      "checks": [["npm", "run", "check"], ["npm", "test"]],
      "reviewPrompt": "Run OCR, investigate its findings and fix valid issues. Rerun after repairs. Report blocked if OCR is unavailable."
    }
  }
}
```

```sh
assembler build --ticket 123 --agent codex --detach
```

The delivery blueprint prepares a worktree, lets agents implement and review/repair,
runs your checks, and has an agent write the PR description from actual evidence.
Code commits and publishes, waits for CI/review feedback, and gives actionable
feedback to an agent to address. By default it permits one remote repair round,
then reports `Ready` or stops with the PR and logs retained. It never merges.

`reviewPrompt` is optional. The default asks the agent to review and repair using
the repository's prescribed tools; Assembler does not install OCR or assume its
CLI syntax. Required GitHub approvals remain required.

This is a blueprint pattern, not a new API: ordinary TypeScript plus `ctx.agent`,
`ctx.exec`, `ctx.step` and `ctx.output`. Agents choose how to solve the task;
the workflow chooses which gates must pass. [Delivery configuration](docs/reference.md#ticket--pr).

## A smaller workflow

```sh
assembler run fix-checks --input '{"checks":[["npm","test"]],"maxRepairs":2}' --agent codex
```

The workflow runs tests. If they fail, it gives the diagnostics to an agent,
then runs tests again—even after the final repair. Already-green checks skip
the agent. Exhausted repairs produce a failed run.

The agent decides **how to fix it**. Code decides **whether the checks passed
and whether another attempt is allowed**. Passing tests is not proof of correctness,
but it is stronger evidence than an agent saying “done.”

## Run now. Inspect later.

```sh
assembler run my-workflow --prompt "Fix issue 123" --detach
# Returns a run ID; Linux only.

assembler runs list
assembler runs show <id>
assembler runs logs <id> --follow
assembler runs cancel <id>
```

One local worker per project executes a persistent queue, one run at a time by
default. To allow two simultaneous runs:

```sh
assembler worker start --concurrency 2
```

Concurrency does not isolate checkouts. Use a workflow with separate worktrees
or containers before running edits in parallel. No automatic retries or
resume-after-crash guarantees. [Background runs and logs](docs/runs.md).

## Workflows

- [Sandbox delivery](examples/gvisor/README.md#one-agent-delivery-task--pr): fresh
  gVisor checkout → one agent handles development through CI → verified PR → cleanup.
  Linux/Codex example; requires explicit GitHub credentials.
- [Write a workflow](docs/reference.md#write-a-typescript-workflow): typed inputs,
  named agent steps, outputs and ordinary TypeScript.
- [Ticket → PR](docs/reference.md#ticket--pr): fetch through GitHub/Linear CLIs,
  implement, review, repair, and verify CI. Does not merge automatically.
- [gVisor task](examples/gvisor/README.md): clone a fresh repository in an isolated
  container, run a prompt, retain the result and patch, then remove the container
  and temporary checkout. Defaults to the current project's Git `origin`.
- [Smaller examples](examples): structured results, parallel steps and failures.
- [Configuration and API reference](docs/reference.md).

The gVisor example deliberately runs the Codex CLI **inside the container**;
ordinary `ctx.agent()` steps use the SDKs. Workflows themselves are trusted code
running on the host, not a sandbox.

## Development

```sh
npm ci
npm run check
npm test
npm run build
```

MIT licensed. Part of [Machinist](https://github.com/owainlewis/machinist):
Assembler executes workflows; the factory decides what work to submit.
