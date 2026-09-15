# Delivery workflow evaluation — 2026-09-15

## Verdict

The basic delivery and clean-PR continuation paths work. The workflow is not
ready to call reliably unattended: a correct, externally validated change was
blocked because the reviewer did not receive the workflow's validation evidence.
Tracked in [issue #24](https://github.com/owainlewis/assembler/issues/24).

These are small live smoke tests, not a statistical success-rate or provider benchmark.
No PRs were merged as part of this evaluation.

## Live results

| Case | Outcome | Elapsed | Agent calls | Workflow validation |
| --- | --- | --- | --- | --- |
| #18: sanitize output paths | Ready; [PR #23](https://github.com/owainlewis/assembler/pull/23) | 5m 45s | 4 | Typecheck, 58 tests, build; remote Linux/macOS CI and review passed |
| #14: honor command-agent timeouts | False review blocker; fix retained in worktree, no PR | 4m 04s | 3 | Typecheck, 65 tests and build passed |
| Repeat #18 against its existing PR | Ready; same PR and commit, no implementation step | 2m 13s | 2 | Checks/review rerun; remote state rechecked |
| Submit a Neo issue against Assembler | Correctly rejected | Under 1s | 0 | Stopped before task fetch or worktree creation |

“Agent calls” means completed SDK invocations, not internal reasoning turns or
repair iterations. Neither initial delivery entered a workflow repair iteration.

Both initial jobs ran concurrently in separate worktrees. The main checkout's
uncommitted repository-discovery changes and unrelated hello.ts were not included.
The test worker was stopped and its concurrency restored to one afterward.

## What the tests establish

- Real GitHub issue fetching and task identity validation succeeded.
- Worktree creation, dependency setup, implementation and independent review ran.
- #18 was committed/pushed by the workflow, which opened exactly one PR and waited
  for remote checks/review before reporting Ready.
- The second #18 run skipped implementation and PR creation. Its head remained
  `a3c7352ebc1cd0e53f31e3d94aa84bcc17b79ccd`; the worktree stayed clean.
- Completed/failed runs released their per-ticket locks.
- A separate before/after subprocess check reproduced #18's unsafe path output
  on the original code and verified sanitization in the fix. It also demonstrated
  that both original plain/structured command-agent paths ignored a 40ms timeout,
  while the fixed paths returned “Command timed out.”

## Confirmed delivery defect: reviewer lacks validation evidence

On #14, Assembler successfully ran its configured validation in 27.4 seconds.
The reviewer subsequently attempted tests in a read-only sandbox and returned:

> Acceptance remains unverified because runtime tests fail during setup with EROFS in the read-only environment.

Delivery stopped before commit/PR creation. This was a workflow false blocker,
not a failing change. The review prompt contains the task and diff but not the
successful command results from the preceding validation step.

Implementation also wastes time on environment restrictions: #18's agent made
several unsuccessful test attempts, including `tsx` failing to create an IPC
socket with EPERM. The workflow's external checks then passed in 25.6 seconds.

Issue #24 specifies the fix: communicate the execution boundary and give review
structured validation evidence tied to the code being reviewed. Do not weaken
checks, silently dismiss real failures, or broaden agent permissions.

## Performance observations

- Agent-based issue fetching took 22.1s and 23.4s; repeat fetching took 20.3s.
  Direct CLI parsing may remove an unnecessary agent invocation for GitHub tasks.
- #18 spent 76.8s implementing, 25.6s in workflow checks, 35.1s reviewing,
  138.3s waiting for CI/review, and 28.3s assessing feedback.
- #14 spent 125.9s implementing and 55.1s reviewing before its false blocker.
- Clean continuation still took 133.2s, including refetch, reinstall, full checks,
  fresh review and a quiet remote-feedback window. It is verification, not a no-op.
- These runs do not establish superiority in cost or quality over a single agent,
  nor do they compare Claude with Codex.

## Remaining coverage and safety work

The existing automated delivery tests simulate failed-CI repair, review repair,
repair-budget/stalled-progress failures, changed heads, missing checks, drafts,
required reviews, conflicts and thread-resolution errors. They ran in the live
validation suites, but these smoke tests did not exercise a real remote CI failure
or a successful live repair iteration. Linear and Claude were not tested live here.

Before unattended rollout, fix #24 and address the already-open dirty-worktree
continuation (#8) and review-thread resolution (#9) issues. Then repeat #14 and
exercise an explicit failed-CI/review-repair case without weakening acceptance gates.

## Reproduction and retained evidence

From the Assembler project, the tested invocation was:

```sh
assembler build --ticket 18 --agent codex --detach --input '{"setup":[["npm","ci"]],"checks":[["npm","run","check"],["npm","test"],["npm","run","build"]],"localRepairs":2,"feedbackRepairs":2,"feedbackTimeoutMs":600000,"pollMs":15000,"reviewQuietMs":30000}'
```

The actual invocation snapshots also retain the focused implementation prompts.
Inspect the local runs with `assembler runs show <id>` or `runs logs <id>`:

- #18 initial: `2026-09-15T10-32-59.079Z-dff2469c`
- #14 blocked: `2026-09-15T10-33-20.991Z-dc8197b0`
- #18 continuation: `2026-09-15T10-39-03.637Z-7a8260aa`
- Wrong-repository rejection: `2026-09-15T10-38-30.434Z-ed3f18d7`

The #14 changes remain uncommitted on branch `assembler/github-assembler-14` in
the sibling `.assembler-worktrees/assembler/github-assembler-14` directory.
Inspect that worktree before reusing it; it intentionally retains the failed run's work.
The local proof script is `.assembler/demos/delivery-regressions.mjs` (ignored in Git).
