import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import build from "../examples/task-to-pr.js";
import { defaults, defineWorkflow, runWorkflow, z } from "../src/index.js";
import { githubIssue } from "../examples/lib/tickets.js";
import { checkState, waitFeedback } from "../examples/lib/github.js";

test("issue reference must match the project", () => {
  assert.equal(githubIssue("123", "owner/repo"), 123);
  assert.equal(githubIssue("https://github.com/owner/repo/issues/123", "owner/repo"), 123);
  assert.throws(() => githubIssue("https://github.com/other/repo/issues/123", "owner/repo"), /does not match/);
});
test("CI readiness requires registered, completed checks", () => {
  assert.equal(checkState([]), "pending");
  assert.equal(checkState([{ status: "IN_PROGRESS" }]), "pending");
  assert.equal(checkState([{ status: "COMPLETED", conclusion: "FAILURE" }]), "failed");
  assert.equal(checkState([{ status: "COMPLETED", conclusion: "SUCCESS" }]), "passed");
});

async function simulatedDelivery(options: { positiveComment?: boolean; feedbackBlocked?: boolean; feedback?: boolean; ciFailure?: boolean; noProgress?: boolean; changeHead?: boolean; missingChecks?: boolean; existing?: boolean; reviewDecision?: string; mergeable?: string; isDraft?: boolean; resolveError?: boolean; dirty?: boolean; reviewBlocked?: boolean; omitThread?: boolean; unknownThread?: boolean; staleDescription?: boolean; localFailure?: boolean; feedbackRepairs?: number; checkMutates?: boolean } = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), "assembler-delivery-"));
  const dir = join(sandbox, "project");
  await mkdir(dir);
  const commands: string[][] = [], steps: string[] = [], outputs: any[] = [];
  let head = options.existing ? "sha-1" : "sha-0", activeThread = !!options.feedback, repaired = false;
  let dirty = !!options.dirty, tree = "tree-0", checksRun = 0, descriptionBody = "";
  const result = (stdout = "", exitCode = 0) => ({ stdout, stderr: "", exitCode, log: "test.log" });
  const json = (value: unknown) => result(JSON.stringify(value));
  const ctx: any = {
    project: dir, config: defaults, signal: new AbortController().signal,
    input: { ticket: "123", prompt: "CUSTOM BUILD INSTRUCTIONS", reviewPrompt: "Run OCR and address valid findings", checks: [["node", "check"]], feedbackRepairs: options.feedbackRepairs, reviewQuietMs: 0, pollMs: 1, feedbackTimeoutMs: options.missingChecks ? 20 : 1000 },
    output: (name: string, value: unknown) => outputs.push({ name, value }),
    step: async (name: string, action: () => Promise<unknown>) => { steps.push(name); return action(); },
    at: (project: string) => ({ ...ctx, project }),
    agent: async (name: string, settings: any) => {
      steps.push(name);
      if (name === "Fetch task") return { data: { status: "ready", reason: "Fetched", task: {
        identifier: "123", title: "Fix parser", description: "Acceptance criteria", comments: [], acceptanceCriteria: ["Fix parser"],
        url: "https://github.com/owner/repo/issues/123", state: "open", complete: true,
      } }, commands: settings.readCommands.map((command: string) => ({ command, exitCode: 0 })) };
      if (name === "Implement") assert.match(settings.prompt, /CUSTOM BUILD INSTRUCTIONS/);
      if (name === "Review and repair") {
        assert.match(settings.prompt, /Run OCR/);
        assert.notEqual(settings.readOnly, true);
        return { data: { status: options.reviewBlocked ? "blocked" : "completed", summary: options.reviewBlocked ? "OCR unavailable" : "OCR findings addressed" } };
      }
      if (name === "Write PR description") {
        assert.equal(settings.readOnly, true);
        assert.match(settings.prompt, /"exitCode":0/);
        assert.match(settings.prompt, /"tree":"tree-0"/);
        assert.match(settings.prompt, /OCR findings addressed/);
        if (options.staleDescription) tree = "tree-unvalidated";
        return { data: { title: "Fix parser edge case", body: "Fixed parser. Evidence: node check passed. Remaining risks: none identified." } };
      }
      if (name.startsWith("Repair checks")) assert.match(settings.prompt, /Workflow check evidence/);
      if (name.startsWith("Address feedback")) {
        assert.doesNotMatch(settings.prompt, /CUSTOM BUILD INSTRUCTIONS/);
        assert.match(settings.prompt, /Run OCR/);
        assert.match(settings.prompt, /Do not rerun passing checks/);
        const evidence = JSON.parse(settings.prompt.slice(settings.prompt.lastIndexOf("\n") + 1));
        assert.equal(evidence.head, head);
        assert.equal(evidence.localValidation.tree, tree);
        assert.equal(evidence.localValidation.checks[0].stdout, `check output ${checksRun}`);
        assert.equal(evidence.localValidation.checks[0].exitCode, 0);
        if (options.feedbackBlocked) return { data: { status: "blocked", summary: "Cannot read failing job logs", addressedThreads: [] } };
        if (activeThread || (options.ciFailure && head === "sha-1")) { repaired = true; dirty = true; tree = "tree-1"; }
        return { data: { status: "completed", summary: "Fixed the reported parser defect", addressedThreads: options.unknownThread ? ["unknown"] : activeThread && !options.omitThread ? ["thread-1"] : [] } };
      }
      return { text: "done" };
    },
    exec: async (command: string[]) => {
      commands.push(command);
      const text = command.join(" ");
      if (text.startsWith("gh repo view")) return json({ nameWithOwner: "owner/repo", defaultBranchRef: { name: "main" } });
      if (text.startsWith("gh pr list")) return json(options.existing ? [{ number: 456, url: "https://github.com/owner/repo/pull/456", state: "OPEN", baseRefName: "main" }] : []);
      if (text.includes("--git-common-dir")) return result(dir);
      if (text.startsWith("git show-ref")) return result("", 1);
      if (text.startsWith("git worktree list") || text.startsWith("git ls-remote")) return result("");
      if (text === "git status --porcelain") return result(dirty ? " M a.ts" : "");
      if (text === "git write-tree") return result(tree);
      if (text === "git rev-parse HEAD^{tree}") return result(tree);
      if (text === "node check") { checksRun++; if (options.checkMutates) tree = "changed-by-check"; return result(`check output ${checksRun}`, options.localFailure ? 1 : 0); }
      if (text.startsWith("git diff --cached")) return result("", options.existing && !repaired ? 0 : 1);
      if (text.startsWith("git diff")) return result("diff of parser fix");
      if (text.startsWith("git commit")) { dirty = false; if (!options.noProgress || !repaired) head = repaired ? "sha-2" : "sha-1"; return result(); }
      if (text.startsWith("gh pr create")) descriptionBody = await readFile(command[command.indexOf("--body-file") + 1], "utf8");
      if (text === "git rev-parse HEAD") return result(head);
      if (text.startsWith("gh pr view") && text.includes("statusCheckRollup")) return json({ headRefOid: options.changeHead ? "unexpected" : head, state: "OPEN", reviewDecision: options.reviewDecision ?? "", isDraft: options.isDraft ?? false, mergeable: options.mergeable ?? "MERGEABLE", statusCheckRollup: options.missingChecks ? [] : [{ name: "CI", status: "COMPLETED", conclusion: options.ciFailure && head === "sha-1" ? "FAILURE" : "SUCCESS" }] });
      if (text.startsWith("gh pr view") && text.endsWith("--json headRefOid")) return json({ headRefOid: head });
      if (text.startsWith("gh pr view")) return json({ number: 456, url: "https://github.com/owner/repo/pull/456" });
      if (text.includes("resolveReviewThread")) { if (options.resolveError) return json({ errors: [{ message: "Denied" }] }); activeThread = false; return json({ data: { resolveReviewThread: { thread: { isResolved: true } } } }); }
      if (text.includes("reviewThreads")) return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: activeThread ? [{ id: "thread-1", isResolved: false, comments: { pageInfo: { hasNextPage: false }, nodes: [{ id: "comment-1", body: "fix bug" }] } }] : [] } } } } });
      if (text.includes("--slurp")) return json([options.positiveComment && text.includes("/comments") ? [{ id: 1, body: "No actionable issues found. All checks passed." }] : []]);
      return result();
    },
  };
  try {
    let error: unknown;
    try { await build(ctx); } catch (caught) { error = caught; }
    await assert.rejects(access(join(dir, "assembler", "github-repo-123.lock")));
    return { error, commands, steps, outputs, descriptionBody, checksRun };
  } finally { await rm(sandbox, { recursive: true }); }
}

test("ticket to PR performs review, remote repair, resolves threads and verifies ready", async () => {
  const run = await simulatedDelivery({ feedback: true });
  assert.equal(run.error, undefined);
  assert.ok(run.steps.includes("Address feedback 1"));
  assert.ok(run.steps.includes("Review and repair"));
  assert.ok(!run.steps.some(step => step.startsWith("Assess feedback") || step.startsWith("Code review")));
  assert.ok(run.steps.includes("Fetch task"));
  assert.ok(run.outputs.some(output => output.name === "Task"));
  assert.ok(run.commands.some(command => command.includes("assembler/github-repo-123")));
  assert.ok(run.commands.some(command => command.includes("--body-file")));
  assert.match(run.descriptionBody, /Evidence: node check passed/);
  assert.match(run.descriptionBody, /Fixes https:\/\/github.com\/owner\/repo\/issues\/123/);
  assert.doesNotMatch(run.descriptionBody, /Independent local code review completed/);
  assert.equal(run.outputs.at(-1).name, "Ready");
  assert.equal(run.outputs.at(-1).value.head, "sha-2");
});
test("existing PR is reused without creating another PR or reimplementing", async () => {
  const run = await simulatedDelivery({ existing: true });
  assert.equal(run.error, undefined);
  assert.ok(!run.steps.includes("Implement"));
  assert.ok(!run.commands.some(command => command.join(" ").startsWith("gh pr create")));
  assert.ok(run.steps.includes("Review and repair"));
  assert.ok(!run.steps.includes("Write PR description"));
});
test("failed remote CI triggers a repair and must pass on the new head", async () => {
  const run = await simulatedDelivery({ ciFailure: true });
  assert.equal(run.error, undefined);
  assert.ok(run.steps.includes("Address feedback 1"));
  assert.equal(run.outputs.at(-1).name, "Ready");
  assert.equal(run.outputs.at(-1).value.head, "sha-2");
});
test("stalled repair, changed head and missing checks never produce Ready", async () => {
  for (const [options, reason] of [[{ feedback: true, noProgress: true }, /made no progress/], [{ changeHead: true }, /differs from the worktree/], [{ missingChecks: true }, /Timed out/]] as const) {
    const run = await simulatedDelivery(options);
    assert.match(String(run.error), reason);
    assert.ok(!run.outputs.some(output => output.name === "Ready"));
  }
});
test("drafts, outstanding approvals, conflicts and failed thread resolution block readiness", async () => {
  for (const options of [{ isDraft: true }, { reviewDecision: "CHANGES_REQUESTED" }, { reviewDecision: "REVIEW_REQUIRED" }, { mergeable: "CONFLICTING" }, { mergeable: "UNKNOWN" }, { feedback: true, resolveError: true }]) {
    const run = await simulatedDelivery(options);
    assert.match(String(run.error), /Required GitHub review|cannot declare Ready|Unable to resolve/);
    assert.ok(!run.outputs.some(output => output.name === "Ready"));
  }
});

test("review tool blockers and local failures prevent publication", async () => {
  for (const options of [{ reviewBlocked: true }, { localFailure: true }]) {
    const run = await simulatedDelivery(options);
    assert.match(String(run.error), /OCR unavailable|No progress|budget exhausted/);
    assert.ok(!run.commands.some(command => command[0] === "git" && command[1] === "push"));
    assert.ok(!run.steps.includes("Write PR description"));
  }
});

test("dirty continuation stops before any agent can edit retained work", async () => {
  const run = await simulatedDelivery({ existing: true, dirty: true });
  assert.match(String(run.error), /worktree is dirty/);
  assert.ok(!run.steps.includes("Review and repair"));
  assert.ok(!run.commands.some(command => command.join(" ") === "git add -A"));
});

test("changed candidates invalidate check evidence before publication", async () => {
  for (const options of [{ staleDescription: true }, { checkMutates: true }]) {
    const run = await simulatedDelivery(options);
    assert.match(String(run.error), /changed after validation|Checks changed the candidate/);
    assert.ok(!run.commands.some(command => command[0] === "git" && command[1] === "push"));
  }
});

test("threads not explicitly reported as addressed remain unresolved", async () => {
  const run = await simulatedDelivery({ feedback: true, omitThread: true });
  assert.ok(run.error);
  assert.ok(!run.commands.some(command => command.some(arg => arg.includes("resolveReviewThread"))));
  assert.ok(!run.outputs.some(output => output.name === "Ready"));
});

test("unknown thread IDs cannot authorize resolution", async () => {
  const run = await simulatedDelivery({ feedback: true, unknownThread: true });
  assert.match(String(run.error), /unknown review thread/);
  assert.ok(!run.commands.some(command => command.some(arg => arg.includes("resolveReviewThread"))));
});

test("zero remote repairs waits for CI but never invokes a repair for failed CI", async () => {
  const run = await simulatedDelivery({ ciFailure: true, feedbackRepairs: 0 });
  assert.match(String(run.error), /Remote feedback repair budget exhausted/);
  assert.ok(!run.steps.some(name => name.startsWith("Address feedback")));
  assert.ok(!run.outputs.some(output => output.name === "Ready"));
});

test("green CI without feedback does not need an assessment agent", async () => {
  const run = await simulatedDelivery();
  assert.equal(run.error, undefined);
  assert.ok(!run.steps.some(name => name.startsWith("Address feedback") || name.startsWith("Assess feedback")));
  assert.equal(run.outputs.at(-1).name, "Ready");
});

test("positive feedback uses validated evidence without reopening the task", async () => {
  const run = await simulatedDelivery({ positiveComment: true });
  assert.equal(run.error, undefined);
  assert.ok(run.steps.includes("Address feedback 1"));
  assert.equal(run.checksRun, 1);
  assert.equal(run.outputs.at(-1).name, "Ready");
});

test("feedback evidence is refreshed after a repair on the new head", async () => {
  const run = await simulatedDelivery({ ciFailure: true, positiveComment: true });
  assert.equal(run.error, undefined);
  assert.ok(run.steps.includes("Address feedback 2"));
  assert.equal(run.checksRun, 2);
  assert.equal(run.outputs.at(-1).value.head, "sha-2");
});

test("missing evidence needed to investigate failing CI still blocks readiness", async () => {
  const run = await simulatedDelivery({ ciFailure: true, feedbackBlocked: true });
  assert.match(String(run.error), /Feedback blocked: Cannot read failing job logs/);
  assert.ok(!run.outputs.some(output => output.name === "Ready"));
});

test("typed workflow input fails before any step executes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembler-input-"));
  try {
    let called = false;
    const workflow = defineWorkflow({ input: z.object({ pr: z.number() }), run: async () => { called = true; } });
    await assert.rejects(runWorkflow(workflow, { project: dir, config: defaults, input: { pr: "bad" } }));
    assert.equal(called, false);
  } finally { await rm(dir, { recursive: true }); }
});
test("scoped contexts retain parsed workflow defaults and share named steps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembler-scope-"));
  try {
    const workflow = defineWorkflow({ input: z.object({ prompt: z.string().default("default prompt") }), async run(ctx) {
      const scoped = ctx.at(dir);
      assert.equal(scoped.input.prompt, "default prompt");
      const result = await scoped.agent("Named agent", { prompt: scoped.input.prompt });
      ctx.output("Answer", result.text);
    } });
    const run = await runWorkflow(workflow, { project: dir, input: {}, config: { ...defaults, agent: "fake", agents: { fake: { provider: "command", command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"] } } } });
    const { readFile } = await import("node:fs/promises");
    const report = JSON.parse(await readFile(join(run, "run.json"), "utf8"));
    assert.equal(report.rows[0].name, "Named agent");
    assert.equal(report.outputs[0].value, "default prompt");
  } finally { await rm(dir, { recursive: true }); }
});
