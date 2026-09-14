# Tasks inside gVisor

These are repository examples, not built-in backends. On a configured Linux
checkout, run the same workflow in the background:

```sh
assembler run gvisor-task --prompt "Review the code" --detach
assembler runs list
assembler runs show <id>
assembler runs logs <id> --follow
assembler runs cancel <id>
```

The tracked registration in `.assembler/workflows/gvisor-task.ts` points to the
example. For several isolated tasks, set `assembler worker start --concurrency 2`
and submit each separately. See [background run semantics](../../docs/runs.md).

## Review the latest Assembler code

On this development server, the launcher and project workflow are installed:

```sh
assembler run gvisor-task --prompt "Review the code"
```

This works from the root shell without Node paths or environment flags. The local
`/usr/local/bin/assembler` launcher defaults to this checkout, selects its Node
installation, and drops root to `machinist` with temporary Docker group access.
It does not change your shell's PATH or grant permanent group membership. `--project` overrides
the configured project. The registration lives in `.assembler/workflows/gvisor-task.ts`,
not in the core runtime. Other machines still need their own installation and Docker
permissions; this is a local development launcher, not an npm release.

Without that local installation, run from a checkout with Node and Docker access:

```sh
node dist/cli.js run examples/gvisor-task.ts --prompt "Review the code"
```

The default repository is **owainlewis/assembler**. Every run clones its latest
default branch inside a new gVisor container, records the exact commit, runs your
prompt, saves the response and a patch, then removes the container and clone.
It does not share your local checkout, include unpushed changes, or provide GitHub
credentials. Each run has its own workspace, so concurrent runs cannot edit the
same checkout. This prevents checkout conflicts, not every possible security risk.

The reusable task instructions live in [Markdown](prompts/task.md).
Use `--input '{"repo":"owainlewis/neo"}'` to choose a different public repository.
Private repositories are not supported by this example. Review tasks produce an
empty patch unless the agent disregards the review instruction; inspect the saved
patch before applying anything. Ignored files and dependency folders are not exported.
Patch export is limited to 64 KB in this example; larger output fails explicitly
rather than saving an incomplete patch. Export uses `docker exec` because Docker's
archive API cannot see files in gVisor's private tmpfs.
There is no automatic push or PR creation, and no guarantee of code correctness.

The response is in `.assembler/runs/<run>/`; the patch and cleanup logs remain in
`.assembler/demos/task-*/`. The temporary `workspace/` is removed on success,
failure, and ordinary cancellation (provided Docker cleanup succeeds).
The default Node image includes Git; custom images must supply it too.

Assembler changes into `--project` before loading workflows so helper processes
don't inherit an inaccessible directory such as `/root`.

## Small verified repair demo

Run from the Assembler checkout on a Linux host with Docker access:

```sh
npm run build
node dist/cli.js run examples/gvisor-demo.ts --agent codex
```

The example uses the existing API, not a proposed backend flag or built-in
workflow. Read [the workflow](../gvisor-demo.ts), its small [container helper](sandbox.ts),
and the [Markdown task](prompts/implement.md).

## What runs

1. Check that Docker has a `runsc` runtime.
2. Copy a deliberately broken slug generator into a new demo workspace.
3. Resolve a Node image to an image ID, shared by both containers in this run.
4. Start an offline gVisor verifier and demonstrate the original assertion failures.
5. Start a separate gVisor coding container and send the Markdown prompt to Codex.
6. Remove the coding container, freezing its activity.
7. Run the unchanged, read-only tests in the offline verifier.
8. Publish the implementation and test output; remove the containers in `finally`.

The agent handles implementation and local iteration. The script handles the
environment, independent verification, outputs, and lifecycle. There is no scripted
repair loop in this example.

## Prerequisites

- Linux, Docker Engine, and gVisor `runsc` using `systrap` (no KVM required).
- Permission to use the selected Docker daemon. Docker daemon access is privileged;
  this example does not add users to the Docker group.
- A standalone Linux Codex executable at `~/.local/bin/codex`, and an existing
  Codex login at `~/.codex/auth.json`. The executable must match the container architecture.
- The `codex-code-mode-host` companion beside the resolved Codex executable,
  and the host CA bundle at `/etc/ssl/certs/ca-certificates.crt` (override with
  the `certificates` input). TLS verification stays enabled.
- Outbound access to pull the Node image and contact the model service.

Follow the [gVisor installation guide](https://gvisor.dev/docs/user_guide/install/)
and [Docker integration guide](https://gvisor.dev/docs/user_guide/quick_start/docker/).
Validate the setup with `docker run --rm --runtime=runsc hello-world`.

Override local paths or pin a toolchain image by digest:

```sh
node dist/cli.js run examples/gvisor-demo.ts --input '{"codex":"/absolute/path/to/codex","auth":"/absolute/path/to/auth.json","image":"node:22-bookworm-slim"}'
```

Only Codex is implemented in this demo. It is invoked with `docker exec` inside
gVisor, not through Assembler's host-side SDK adapter. Markdown is loaded with
`readFile`; this does not introduce an `agent.run(prompt.md)` API yet.

## Security and cleanup boundaries

The coding container has a read-only root filesystem, no Linux capabilities,
resource limits, a disposable scratch home, and only the demo project writable
on the host. The tests, executable and companion, CA bundle, and one credential
file are mounted read-only.
No host Docker socket, whole home directory, or host environment secrets are passed.
The verifier receives neither the credential nor network access.

**The coding agent can read its mounted credential and has outbound network
access.** This is a trusted smoke test, not an adversarial-agent deployment or
an egress-controlled credential proxy. Read-only credentials can still be stolen.
Codex's inner sandbox is disabled inside the externally isolated gVisor container.

The workflow retains `.assembler/demos/gvisor-*/workspace` and normal run logs for
inspection, including failed attempts. Credentials are not copied into those artifacts
or the image. The host image cache is retained. Cleanup gets a separate bounded
signal so Ctrl-C can still remove containers; SIGKILL, host failure, or Docker
unavailability can leave them behind. Inspect these by label:

```sh
docker ps -a --filter label=assembler.demo=gvisor
```

Remove only a confirmed demo container by its exact name with `docker rm -f NAME`.
The default image tag and local Codex executable may change between runs. Use an
image digest and a versioned executable path for reproducible toolchain versions;
model output itself is not deterministic.

## Tested on this development host

Ubuntu 26.04, Docker 29.1.3, gVisor 20260907.0 (`systrap`), Codex 0.154.0.
The live task changed the baseline from 2 passing / 4 failing tests to all 6 passing
in the independent verifier. Failure and SIGINT cleanup were also exercised.
The agent command has a 180-second timeout.

No persistent Docker group membership was granted. On this host an administrator
can run the demo with temporary Docker group access:

```sh
assembler run examples/gvisor-demo.ts --agent codex
```

This temporary group still grants Docker daemon access for the run. Only execute
trusted workflow code this way. The coding container never receives that access.
