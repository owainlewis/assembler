# Background runs and logs

Add `--detach` to submit the same workflow to a local queue. Use `runs`, not
a separate task abstraction, to inspect it. Commands default to the current
project; pass `--project /path/to/repo` when elsewhere. Use the same OS user
for submission and management.

## Submit and inspect

```sh
assembler run my-workflow --prompt "Fix issue 123" --detach
assembler runs list
assembler runs show <id>
assembler runs logs <id> --follow
assembler runs logs <id> --step "Implement" --follow
assembler runs cancel <id>
```

Named workflows live in `.assembler/workflows/<name>.ts`. You can also pass a
TypeScript file inside the project or a built-in name. Input flags, configuration
and agent selection work as in the foreground. Detached schema/module-loading
failures appear in the run record: successful submission is not successful work.

`show` includes steps, errors and named outputs. `logs` includes command output
and provider events. Step filtering accepts an exact name or ID and includes
children. Concurrent logs are grouped by file, not reconstructed chronologically.
Existing foreground runs are inspectable. Publish final answers with
`ctx.output(name, value)`; arbitrary agent text is not automatically an output.

For scripts, use `--json`:

```sh
id=$(assembler run my-workflow --prompt "Review the code" --detach --json | jq -r .id)
assembler runs show "$id" --json
assembler runs logs "$id" --json --follow
```

Log JSON is NDJSON chunks with `id`, `log`, `text`, not provider event objects.
`--events` is foreground-only. Inspection success does not imply run success:
read the record's status.

## Start N tasks

```sh
assembler worker start --concurrency 2
assembler worker status
assembler run my-isolated-workflow --prompt "First task" --detach
assembler run my-isolated-workflow --prompt "Second task" --detach
assembler run my-isolated-workflow --prompt "Third task" --detach
assembler worker stop
```

Submission automatically starts one worker per project. A kernel lock prevents
competing workers. The persistent concurrency limit defaults to 1 (range 1–32).
Excess work waits oldest first. Lowering the limit does not kill existing work.
`worker stop` drains active runs, leaving queued work unstarted. A later start
or detached submission resumes queue processing.

The worker survives terminal closure but is not a boot service. After reboot,
explicitly start it. Detached execution requires Linux and `flock` (util-linux);
foreground execution and inspection remain available on macOS. Use a local
filesystem: this is not a distributed queue.

## Snapshots and isolation

Submission saves merged inputs, agent configuration and project workflow code
and assets before publishing a queued record. Built-in workflow code is copied
too. Relative imports resolve against that snapshot.

This is not a full environment snapshot:

- Packages, executables, credentials and external services remain live
  dependencies. Do not remove or upgrade them while queued work needs them.
- Commands, agents and `ctx.project` still use the real project unless the
  workflow creates its own isolation. Relative filesystem reads use that working
  directory. Read snapshot prompts with `new URL("./prompt.md", import.meta.url)`.
- Custom entries must live inside the project. Snapshots reject symlinks and
  exceedance of 10,000 files or 64 MB.
- Git metadata, dependencies, runtime artifacts, common credential directories
  and `.env*` files are excluded. This is not a secret scanner: other source
  files and configuration may contain secrets.

Do not run concurrent edits in one checkout. Use separate worktrees or containers.
The [gVisor example](../examples/gvisor/README.md) clones a fresh repository per
run and removes its own temporary resources. It clones the latest remote default
branch at execution time, not submission time. Budget container CPU/memory before
raising concurrency. Workflow TypeScript itself is trusted host code.

## Cancellation and crashes

States: `queued`, `running`, `completed`, `failed`, `cancelled`, `interrupted`.
Cancelling terminal runs is harmless. Cancelling queued work does not start a
worker. Running work receives cancellation through `ctx.signal`; use cooperative
code and `finally` cleanup. Commands and SDK calls receive cancellation. Cleanup
commands may need a fresh bounded signal.

The worker allows 30 seconds before force-killing an unresponsive job. Worker
death disconnects IPC and asks running jobs to cancel and clean up. Dead execution
processes are marked interrupted by the worker or inspection commands. Alive but
stuck processes are not assumed dead.

There are no automatic retries. A partially completed push or external effect
must not be repeated blindly. Host crashes and forced kills can bypass cleanup:
inspect containers/worktrees before rerunning an interrupted task. This is not
durable replay, checkpoint resume or exactly-once execution.

## Evidence and retention

`.assembler/runs/<id>/` retains `run.json`, `events.jsonl`, command/provider
logs and output artifacts. Detached runs add `request.json`, source snapshots
and `console.log`. Worker diagnostics are in `.assembler/worker.log`.
Treat these as private: prompts, tools and configuration can contain sensitive
information. There is no automatic pruning policy.

Ignore runtime state while keeping workflow registrations:

```gitignore
.assembler/runs/
.assembler/demos/
.assembler/worker*
```
