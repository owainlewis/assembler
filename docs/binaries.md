# Self-contained CLI releases

Release archives contain an `assembler` launcher, a private Node runtime, production
dependencies, and the source examples. Users do not need Node, npm or a Git checkout
to run the CLI. This is a portable distribution, **not a single-file executable**.
Keep the installed directory intact; copying only the launcher will not work.

## Install

Download the archive and its `.sha256` file from the project's GitHub release.
Names are `assembler-VERSION-PLATFORM-ARCH.tar.gz`:

- Linux: `linux-x64`, `linux-arm64` (glibc, not Alpine/musl).
- macOS: `darwin-arm64` (Apple Silicon), `darwin-x64` (Intel).

For example, after downloading the Linux x64 release:

```sh
sha256sum -c assembler-0.1.0-linux-x64.tar.gz.sha256
tar -xzf assembler-0.1.0-linux-x64.tar.gz
sh assembler-0.1.0-linux-x64/install.sh
~/.local/bin/assembler --help
```

On macOS use `shasum -a 256 -c FILE.sha256`. These checksums detect corruption;
they are not an independent signature. macOS archives are not notarized.

The installer defaults to `~/.local`, does not require sudo, and does not change
your shell profile. Add `~/.local/bin` to PATH if needed. An optional absolute
prefix can be passed to `install.sh`. Installation refuses to overwrite an
unmanaged `assembler` command, including the special launcher on our dev server.
Managed upgrades switch the launcher symlink and retain older versions. Stop
active workers before upgrading; there is no automatic update mechanism.

## Run

```sh
assembler run my-workflow.ts --prompt "Fix the parser"
assembler run examples/task-to-pr.ts --ticket 123
```

Git, gh, agent authentication and project-specific tools remain external. Docker,
gVisor and the standalone Codex executable remain prerequisites for sandbox examples.
The installer does not change Docker permissions or drop privileges for root users.

Project-local workflows continue to resolve from the current project. The example
files ship under `~/.local/lib/assembler/VERSION-PLATFORM-ARCH/app/examples/` and can
be run by absolute path in the foreground. Short names such as `sandbox-delivery`
still require project registration; release packaging does not make examples core
built-ins. Detached custom workflows must live inside the project. Workflows that
import third-party packages still need those packages available in their project.

## Build and release

```sh
npm ci
npm run package:binary
node scripts/smoke-binary.mjs
```

Builds target the current machine's platform and architecture, include its Node
executable/license, and install locked production dependencies in a temporary
directory. The build allowlist excludes local configuration, credentials, task
workspaces and logs. Archives and SHA-256 files land in ignored `release/`.

The GitHub release workflow builds/tests Linux and macOS on x64 and arm64, including
PRs that change packaging scripts, the release workflow or package manifests. Manual
dispatch produces downloadable Actions artifacts. A pushed `vVERSION` tag matching
`package.json` publishes a GitHub release only after every platform passes its tests
and installation smoke test. No release is created on ordinary pushes to main.
The first release must still be explicitly tagged/published.
