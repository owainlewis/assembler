# Execution contracts

The runtime supplies execution, progress and artifacts. Workflows supply engineering
policy. Provider adapters supply coding-agent integration.

| Surface | Contract |
| --- | --- |
| `defineWorkflow({ input, run })` | Validate workflow-owned Zod input before running |
| `ctx.exec(argv)` | Exit code, bounded stdout/stderr tails, full log path |
| `ctx.agent(name, options)` | Named step; text, validated data, provider session/usage |
| `ctx.output(name, value)` | Persist named text/JSON before display |
| `run.json` / `--json` | Versioned final status, step rows and outputs, including failures |
| `events.jsonl` / `--events` | Ordered versioned events and unique step IDs |

## Providers

Official SDK events stay in private per-call logs. Normalized `agent.finished`
events expose session IDs and reported input, cached-input and output tokens.
Cached input is a subset of normalized input; do not add it again. Generic command
adapters do not fabricate metrics.

Schemas go to providers as JSON Schema and are validated locally with Zod.
Schema correctness is not factual correctness. Unsupported schema conversions,
provider failures and invalid responses fail the step. No silent fallback or
Assembler retry; provider-internal retries may still occur.

The explicit command adapter does not claim read-only enforcement, session
recovery or arbitrary tool-chatter parsing. SDK read-only behavior differs:
Codex uses its sandbox; Claude restricts tools. Settings/hooks and workflows
must still be trusted.

Ticket fetching is an agent step using CLI commands, not a tracker API adapter.
`readCommands` explicitly enables networked CLI reads. Claude permits only those
exact Bash commands through a pre-tool hook and disables inherited MCP servers;
Codex uses a read-only filesystem profile with network enabled. Its sandbox does
not constrain remote API methods, so CLI credentials should be read-scoped.
Review steps do not enable this capability. The workflow validates the returned
identity/state/completeness and requires successful commands in SDK tool events,
then saves a task snapshot shared by implementation and review. Extraction remains
agent judgment. Missing tools/authentication fail closed; no alternate transport.

## Workflow policy

The config's `workflows` map holds opaque defaults merged with CLI inputs.
The selected workflow owns their schema. Checks, repairs, ticket sources,
branches and review quiet windows are not runtime options.

Build uses a local ticket claim, stable worktree/branch, local gates and bounded
remote repairs. It records readiness for an exact head, never merges and does
not override required GitHub approvals. Continuation checks branch/head state.
A quiet window cannot guarantee that no future review will arrive.

Fix-checks demonstrates deterministic checks around agent repairs without GitHub
policy. Review-pr demonstrates a fresh verification pass without publishing
findings. All are ordinary exported TypeScript workflows.

## Display and concurrency

Progress uses stderr; published outputs display after the renderer stops,
including on failure. Long values get previews/artifact paths. Display strips
control sequences; files preserve originals. Machine outputs contain full values.

Steps have unique IDs, nested parent IDs and async-local command/output attribution.
Parallel completion may be out of order; outputs remain in publication order.
`ctx.at` scopes execution without a second run. Await steps and isolate editors.

## Failure and recovery

A failed check remains a failed row even if explicit repair later succeeds.
Terminal failure cancels tracked work before the final record. Commands terminate
subprocess groups on supported platforms; SDK calls receive abort signals.
Custom async code must honor cancellation.

Run manifests and feedback state use atomic replacement, not durable replay.
Build locks are local to a shared Git directory. SIGKILL can leave stale locks.
There is no whole-workflow deadline; scheduling should supply one externally.

Future work should follow delivery evidence: crash recovery, distributed claims,
reviewer-specific completion signals, bounded log retention and comparable task
metrics. A successful SDK call is never proof of task correctness.
