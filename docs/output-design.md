# Output and execution contracts

The workflow, provider, and terminal have distinct contracts. They should not share
one stream of text with different consumers guessing what each line means.

| Surface | Purpose | Contract |
| --- | --- | --- |
| `ctx.exec` / `ctx.agent` | Process output | Exit code, raw stdout/stderr tails, truncation flags, log path |
| `ctx.agentJson` | Decisions and data between steps | Native provider schema request where available, plus local Zod validation |
| `ctx.output` | Results for people and downstream jobs | Named text/JSON artifact, saved before display |
| `run.json` / `--json` | Final machine result | Versioned record; same shape on execution success/failure |
| `events.jsonl` / `--events` | Progress consumers | Ordered versioned events with unique step IDs |

## Agent integration

Keep the generic command harness. Add capabilities rather than pretending all
commands offer final-answer extraction, structured output, usage, or sessions.
Codex and Claude have small native structured-output adapters today. Their CLI
processes supply execution, authentication, permissions and cancellation behavior.
The official SDKs are a possible implementation behind the same workflow API when
we need typed tool events, sessions, or usage. They are not required just to obtain
JSON. Do not fall back silently from a failed native call to another provider or
another agent invocation: that could repeat edits and spend unexpectedly.

Schema correctness is not factual correctness. A schema-valid approval is still
an agent judgment. Validation commands and acceptance criteria remain workflow
responsibilities. Conversion to JSON Schema can reject unsupported Zod types
before invoking a provider; transformations are not a portable provider contract.

## Progress and output

The terminal displays named steps, not provider token streams. Progress uses stderr;
named outputs are rendered after the display stops, on success or failure. Non-TTY
logs print each actual state transition once, including out-of-order completion.
The TTY renderer handles wrapping and redraws. Console chatter clears and redraws
the display. Outputs are sanitized for terminal control sequences, but their files
retain original content. Long outputs are previewed; JSON retains complete values.

Parallel steps get distinct IDs even when names match. Async-local context associates
outputs/commands with their enclosing step. Outputs are ordered by publication,
not by step-start order. A nested step records its parent ID. Await all steps;
unawaited work is an error, not a resumability mechanism.

## Failures and cancellation

Process errors, nonzero exits, timeouts, parsing failures and schema failures fail
the step. Workflow code may explicitly catch a failure and repair it. The build
workflow can therefore finish successfully with earlier failed-check rows visible.
On terminal failure the runtime cancels subprocesses and waits for tracked steps
before writing the final record. Custom code must observe the abort signal.
Interrupted processes cannot be assumed to have made no changes.

Run manifests use atomic replacement, but this is not a durable execution engine.
There is no replay, stale-run reconciliation after SIGKILL, or cross-process lock.
Workflow code can bypass the API, write stdout, hang, or create untracked processes.
There is no whole-workflow deadline yet, only command timeouts. Production factory
invocations should retain an outer supervisor deadline and isolate editing jobs.

## Example coverage

- `outputs.ts`: text → schema-backed plan → text review, three published outputs.
- `structured.ts`: validated classification controls the next code branch.
- `parallel.ts`: three command steps finish out of order without provider credentials.
- `failure.ts`: a saved result survives a later nonzero exit.

Remaining design work should be driven by actual workflows: per-step agent/model
selection, explicit approval artifacts, usage capabilities, maximum output/log sizes,
and resume semantics. The present contract deliberately exposes neither fabricated
token totals nor a promise that a successful process means the task is correct.
