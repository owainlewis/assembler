import { mkdir, open, readFile, writeFile, unlink, rename } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";
import { defineWorkflow, z } from "./index.js";
import { commandSchema, instructions, jsonCommand, validateAndRepair, workReportSchema } from "./engineering.js";
import { fetchTicket, linearCommandsSchema } from "./tickets.js";
import { feedback, waitFeedback } from "./github.js";

export const buildInput = z.object({
  ticket: z.string().min(1), prompt: z.string().default("Build this task, meeting its acceptance criteria and adding relevant tests."),
  checks: z.array(commandSchema).min(1), base: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/).optional(),
  setup: z.array(commandSchema).default([]),
  reviewPrompt: z.string().min(1).default("Review the implementation against the task. Investigate and fix correctness defects and missing regression coverage. Use the repository's prescribed review tools. Report what you checked, what you fixed, and any remaining gaps."),
  linearCommands: linearCommandsSchema,
  localRepairs: z.number().int().min(0).max(10).default(3), feedbackRepairs: z.number().int().min(0).max(10).default(1),
  feedbackTimeoutMs: z.number().int().positive().default(1_200_000), pollMs: z.number().int().positive().default(30_000),
  reviewQuietMs: z.number().int().nonnegative().default(60_000),
});

export default defineWorkflow({ input: buildInput, async run(ctx) {
  const repository = await ctx.step("Resolve project", () => jsonCommand(ctx, ["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef"]));
  const repo: string = repository.nameWithOwner;
  const base = ctx.input.base ?? repository.defaultBranchRef.name;
  const ticket = await fetchTicket(ctx, ctx.input.ticket, repo, ctx.input.linearCommands);
  const key = `${ticket.source}-${ticket.key}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const branch = `assembler/${key}`;
  const common = (await ctx.exec(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const stateDir = join(common, "assembler");
  await mkdir(stateDir, { recursive: true });
  const lockPath = join(stateDir, `${key}.lock`);
  const lock = await open(lockPath, "wx").catch(error => {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`Task already claimed: ${lockPath}. If a previous process crashed, verify it stopped before removing the lock.`);
  });
  try {
    await lock.writeFile(String(process.pid));
    const prs = await jsonCommand<any[]>(ctx, ["gh", "pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", "number,state,url,baseRefName"]);
    if (prs.some(pr => pr.state !== "OPEN")) throw new Error("This task already has a closed/merged PR; inspect it before starting new work");
    if (prs.length > 1 || prs.some(pr => pr.baseRefName !== base)) throw new Error("Ambiguous existing PR or changed base branch");
    const worktree = resolve(dirname(ctx.project), ".assembler-worktrees", basename(ctx.project), key);
    await ctx.step("Prepare worktree", async () => {
      await ctx.exec(["git", "fetch", "origin", base]);
      const list = (await ctx.exec(["git", "worktree", "list", "--porcelain"])).stdout;
      const record = list.split("\n\n").find(row => row.startsWith(`worktree ${worktree}\n`));
      if (record) { if (!record.includes(`branch refs/heads/${branch}\n`) && !record.endsWith(`branch refs/heads/${branch}`)) throw new Error("Worktree has an unexpected branch"); return; }
      const local = await ctx.exec(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true });
      await mkdir(dirname(worktree), { recursive: true });
      if (!local.exitCode) await ctx.exec(["git", "worktree", "add", worktree, branch]);
      else {
        const remote = await ctx.exec(["git", "ls-remote", "--heads", "origin", branch]);
        if (remote.stdout.trim()) await ctx.exec(["git", "fetch", "origin", `${branch}:refs/heads/${branch}`]);
        await ctx.exec(remote.stdout.trim() ? ["git", "worktree", "add", worktree, branch] : ["git", "worktree", "add", "-b", branch, worktree, `origin/${base}`]);
      }
    });
    const work = ctx.at(worktree);
    // Never sweep up a previous run's edits (or someone else's) on continuation.
    if ((await work.exec(["git", "status", "--porcelain"])).stdout.trim()) throw new Error("Delivery worktree is dirty; inspect and reconcile retained changes before continuing");
    ctx.output("Delivery", { ticket: ticket.url, branch, worktree });
    if (ctx.input.setup.length) await work.step("Setup project", async () => {
      for (const command of ctx.input.setup) await work.exec(command);
    });
    const task = `${ticket.title}\n${ticket.body}\nTicket: ${ticket.url}`;
    const policy = { task, checks: ctx.input.checks, maxRepairs: ctx.input.localRepairs, base: `origin/${base}` };
    if (!prs.length) {
      await work.agent("Implement", { prompt: `${instructions}${ctx.input.prompt}\nTask:\n${task}` });
    } else {
      const remote = await jsonCommand(work, ["gh", "pr", "view", String(prs[0].number), "--repo", repo, "--json", "headRefOid"]);
      const local = (await work.exec(["git", "rev-parse", "HEAD"])).stdout.trim();
      if (remote.headRefOid !== local) throw new Error("Existing PR differs from the worktree; reconcile before continuation");
    }
    const { data: review } = await work.agent("Review and repair", { schema: workReportSchema,
      prompt: `${instructions}${ctx.input.reviewPrompt}\nTask:\n${task}\nThe workflow runs the configured acceptance checks next. Missing required tools are blockers; do not claim to have run unavailable tools.` });
    ctx.output("Review and repair", review);
    if (review.status === "blocked") throw new Error(`Review blocked: ${review.summary}`);
    await work.exec(["git", "add", "-A"]);
    let validation = await validateAndRepair(work, policy);
    // A Git tree identifies the exact candidate, including new files, before commit.
    await work.exec(["git", "add", "-A"]);
    let tree = (await work.exec(["git", "write-tree"])).stdout.trim();
    const commit = async (label: string) => work.step(label, async () => {
      await work.exec(["git", "add", "-A"]);
      const candidate = (await work.exec(["git", "write-tree"])).stdout.trim();
      const staged = await work.exec(["git", "diff", "--cached", "--quiet"], { allowFailure: true });
      if (staged.exitCode === 1) await work.exec(["git", "commit", "-m", `fix: ${ticket.title.slice(0, 100)}`]);
      else if (staged.exitCode !== 0) throw new Error("Unable to inspect staged changes");
      if ((await work.exec(["git", "rev-parse", "HEAD^{tree}"])).stdout.trim() !== candidate || (await work.exec(["git", "status", "--porcelain"])).stdout.trim())
        throw new Error("Commit changed the validated candidate; inspect hooks and rerun validation before pushing");
      await work.exec(["git", "push", "-u", "origin", branch]);
    });
    let pr = prs[0];
    let description: { title: string; body: string } | undefined;
    if (!pr) {
      const { data } = await work.agent("Write PR description", { readOnly: true,
        schema: z.object({ title: z.string().min(1), body: z.string().min(1) }),
        prompt: `${instructions}Inspect the final diff against origin/${base} and write a concise PR title and Markdown body. Include what changed and why, observed validation results, relevant examples, and remaining risks or gaps. Do not claim unperformed checks or independent approval. Summarize evidence directly; local log paths are not accessible to GitHub readers. Do not rerun tests in your read-only sandbox: use the workflow's actual results below.\n${JSON.stringify({ task, tree, review, checks: validation })}` });
      description = data;
      ctx.output("PR description", data);
    }
    await work.exec(["git", "add", "-A"]);
    if ((await work.exec(["git", "write-tree"])).stdout.trim() !== tree) throw new Error("Code changed after validation; refusing to publish stale evidence");
    await commit("Commit and push");
    if (!pr) await work.step("Open PR", async () => {
      const body = join(stateDir, `${key}.pr.md`);
      await writeFile(body, `${description!.body}\n\n${ticket.source === "github" ? "Fixes" : "Task:"} ${ticket.url}`, { mode: 0o600 });
      await work.exec(["gh", "pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", description!.title, "--body-file", body]);
      pr = await jsonCommand(work, ["gh", "pr", "view", branch, "--repo", repo, "--json", "number,url"]);
    });
    ctx.output("Pull request", pr.url);
    const statePath = join(stateDir, `${key}.feedback.json`);
    let state: { head: string; seen: string[] } = { head: "", seen: [] };
    const saveState = async () => {
      await writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
      await rename(`${statePath}.tmp`, statePath);
    };
    try { state = z.object({ head: z.string(), seen: z.array(z.string()) }).parse(JSON.parse(await readFile(statePath, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (let attempt = 0; attempt <= ctx.input.feedbackRepairs; attempt++) {
      const snapshot = await work.step(`Wait for feedback ${attempt + 1}`, () => waitFeedback(work, repo, pr.number,
        { timeoutMs: ctx.input.feedbackTimeoutMs, pollMs: ctx.input.pollMs, quietMs: ctx.input.reviewQuietMs }));
      const local = (await work.exec(["git", "rev-parse", "HEAD"])).stdout.trim();
      if (local !== snapshot.head) throw new Error("Remote PR head differs from the worktree; reconcile before continuing");
      if (state.head !== snapshot.head) state = { head: snapshot.head, seen: [] };
      const unseen = snapshot.items.filter(item => !state.seen.includes(item.fingerprint));
      let report = { status: "completed" as "completed" | "blocked", summary: "No new feedback", addressedThreads: [] as string[] };
      if (unseen.length || snapshot.ci === "failed") {
        const exhausted = attempt === ctx.input.feedbackRepairs;
        if (exhausted && snapshot.ci === "failed") throw new Error("Remote feedback repair budget exhausted; PR retained");
        const answer = await work.agent(`Address feedback ${attempt + 1}`, { readOnly: exhausted,
          schema: workReportSchema.extend({ addressedThreads: z.array(z.string()) }),
          prompt: `${instructions}Assess only the supplied new feedback and failed CI checks, not the entire task again. The workflow already validated this exact candidate outside your sandbox; use the local validation and current-head CI evidence below. Do not rerun passing checks or probe GitHub connectivity merely to reconfirm supplied evidence. Positive summaries need no response, tool calls, or edits: return completed when nothing needs action.
${exhausted ? "No repair attempts remain. Do not edit; return blocked if feedback needs action." : "Investigate actionable findings and fix valid issues. Only if CI failed, use gh to read failing job logs. If you make repairs, review those changes using the repair review instructions below; the workflow will rerun acceptance checks and publish."}
Return completed only after addressing actionable feedback, or confirming it needs no action. Return blocked when actual outstanding feedback or failed CI cannot be safely addressed, including when tools or evidence required for that work are unavailable. An unnecessary sandbox retry does not invalidate supplied passing evidence. List ONLY review thread IDs whose requested changes you actually implemented, and explain each resolution in your summary. Never list an ID merely because you read it or disagree with it. Do not resolve threads yourself.
Repair review instructions (only if you change code): ${ctx.input.reviewPrompt}
${JSON.stringify({ task, head: snapshot.head, localValidation: { tree, checks: validation }, ci: snapshot.ci, checks: snapshot.checks, items: unseen })}` });
        report = answer.data;
        ctx.output(`Feedback result ${attempt + 1}`, report);
      }
      if (report.status === "blocked") throw new Error(`Feedback blocked: ${report.summary}`);
      if (report.addressedThreads.some(id => !unseen.some(item => item.threadId === id))) throw new Error("Agent reported an unknown review thread");
      const changed = (await work.exec(["git", "status", "--porcelain"])).stdout.trim();
      if (snapshot.ci === "passed" && !changed) {
        // Never declare readiness for a head that changed during assessment.
        const latest = await feedback(work, repo, pr.number);
        if (latest.head !== snapshot.head || latest.ci !== "passed" || latest.items.some(item => !snapshot.items.some(old => old.fingerprint === item.fingerprint))) throw new Error("PR changed during assessment; rerun to collect fresh feedback");
        const threads = latest.items.filter(item => item.threadId);
        if (threads.length) throw new Error("Unresolved review threads remain; address or explicitly dismiss them before readiness");
        if (latest.reviewDecision === "CHANGES_REQUESTED" || latest.reviewDecision === "REVIEW_REQUIRED") throw new Error(`Required GitHub review remains outstanding: ${latest.reviewDecision}`);
        if (latest.isDraft !== false || latest.mergeable !== "MERGEABLE") throw new Error("PR is draft, conflicting, or mergeability is not yet known; cannot declare Ready");
        state = { head: snapshot.head, seen: snapshot.items.map(item => item.fingerprint) };
        await saveState();
        ctx.output("Ready", { pr: pr.url, head: snapshot.head, checks: "passed", feedback: "assessed", merged: false });
        return;
      }
      if (attempt === ctx.input.feedbackRepairs) throw new Error("Remote feedback repair budget exhausted; PR retained");
      if (!changed) throw new Error("Feedback repair made no progress");
      await work.exec(["git", "add", "-A"]);
      validation = await validateAndRepair(work, { ...policy, task: `${task}\nRequired feedback fixes:\n${JSON.stringify({ report, items: unseen })}` });
      tree = (await work.exec(["git", "write-tree"])).stdout.trim();
      const beforePush = await jsonCommand(work, ["gh", "pr", "view", String(pr.number), "--repo", repo, "--json", "headRefOid"]);
      if (beforePush.headRefOid !== snapshot.head) throw new Error("PR head changed during repair; reconcile before pushing");
      await commit(`Push repair ${attempt + 1}`);
      const nextHead = (await work.exec(["git", "rev-parse", "HEAD"])).stdout.trim();
      if (nextHead === snapshot.head) throw new Error("Feedback repair made no progress");
      const fresh = await feedback(work, repo, pr.number);
      if (fresh.head !== nextHead) throw new Error("PR head changed after push");
      for (const item of unseen.filter(item => item.threadId && report.addressedThreads.includes(item.threadId))) {
        if (!fresh.items.some(current => current.threadId === item.threadId && current.fingerprint === item.fingerprint)) continue;
        const resolved = await jsonCommand(work, ["gh", "api", "graphql", "-f", "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}", "-f", `id=${item.threadId}`]);
        if (resolved.errors?.length || resolved.data?.resolveReviewThread?.thread?.isResolved !== true) throw new Error("Unable to resolve verified review thread");
      }
      state = { head: nextHead, seen: [] };
      await saveState();
    }
  } finally { await lock.close(); await unlink(lockPath); }
} });
