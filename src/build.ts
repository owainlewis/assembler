import { mkdir, open, readFile, writeFile, unlink, rename } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";
import { defineWorkflow, z, type Context } from "./index.js";
import { commandSchema, instructions, jsonCommand, validateAndReview, reviewSchema } from "./engineering.js";
import { fetchTicket, linearCommandsSchema } from "./tickets.js";
import { feedback, waitFeedback } from "./github.js";

export const buildInput = z.object({
  ticket: z.string().min(1), prompt: z.string().default("Build this task, meeting its acceptance criteria and adding relevant tests."),
  checks: z.array(commandSchema).min(1), base: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/).optional(),
  setup: z.array(commandSchema).default([]),
  linearCommands: linearCommandsSchema,
  localRepairs: z.number().int().min(0).max(10).default(3), feedbackRepairs: z.number().int().min(0).max(10).default(3),
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
    await work.exec(["git", "add", "-A"]);
    await validateAndReview(work, policy);
    const commit = async (label: string) => work.step(label, async () => {
      await work.exec(["git", "add", "-A"]);
      const staged = await work.exec(["git", "diff", "--cached", "--quiet"], { allowFailure: true });
      if (staged.exitCode === 1) await work.exec(["git", "commit", "-m", `fix: ${ticket.title.slice(0, 100)}`]);
      else if (staged.exitCode !== 0) throw new Error("Unable to inspect staged changes");
      await work.exec(["git", "push", "-u", "origin", branch]);
    });
    await commit("Commit and push");
    let pr = prs[0];
    if (!pr) await work.step("Open PR", async () => {
      const body = join(stateDir, `${key}.pr.md`);
      await writeFile(body, `${ticket.title}\n\n${ticket.source === "github" ? "Fixes" : "Task:"} ${ticket.url}\n\nValidation: ${ctx.input.checks.map(command => command.join(" ")).join("; ")}\n\nIndependent local code review completed.`, { mode: 0o600 });
      await work.exec(["gh", "pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", ticket.title, "--body-file", body]);
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
      let assessment: z.output<typeof reviewSchema> = { decision: "approved", summary: "No new feedback", findings: [] };
      if (unseen.length || snapshot.ci === "failed") {
        const answer = await work.agent(`Assess feedback ${attempt + 1}`, { readOnly: true, schema: reviewSchema,
          prompt: `${instructions}Assess this feedback against the current code. No edits. Return changes_required for actionable findings or failed checks, blocked if unable to decide or a review is still running, approved only if feedback needs no action. Positive summaries need no response.\n${JSON.stringify({ task, head: snapshot.head, ci: snapshot.ci, checks: snapshot.checks, items: unseen })}` });
        assessment = answer.data;
        ctx.output(`Feedback assessment ${attempt + 1}`, assessment);
      }
      if (assessment.decision === "blocked") throw new Error(`Feedback blocked: ${assessment.summary}`);
      if (snapshot.ci === "passed" && assessment.decision === "approved") {
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
      await work.agent(`Repair feedback ${attempt + 1}`, { prompt: `${instructions}Fix the valid feedback and failed checks. Use gh to inspect failing check logs if necessary.\n${ctx.input.prompt}\nTask:\n${task}\n${JSON.stringify({ assessment, checks: snapshot.checks, items: unseen })}` });
      await work.exec(["git", "add", "-A"]);
      await validateAndReview(work, { ...policy, task: `${task}\nRequired feedback fixes:\n${JSON.stringify({ assessment, items: unseen })}` });
      await commit(`Push repair ${attempt + 1}`);
      const nextHead = (await work.exec(["git", "rev-parse", "HEAD"])).stdout.trim();
      if (nextHead === snapshot.head) throw new Error("Feedback repair made no progress");
      const fresh = await feedback(work, repo, pr.number);
      if (fresh.head !== nextHead) throw new Error("PR head changed after push");
      for (const item of unseen.filter(item => item.threadId)) {
        if (!fresh.items.some(current => current.threadId === item.threadId && current.fingerprint === item.fingerprint)) continue;
        const resolved = await jsonCommand(work, ["gh", "api", "graphql", "-f", "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}", "-f", `id=${item.threadId}`]);
        if (resolved.errors?.length || resolved.data?.resolveReviewThread?.thread?.isResolved !== true) throw new Error("Unable to resolve verified review thread");
      }
      state = { head: nextHead, seen: [] };
      await saveState();
    }
  } finally { await lock.close(); await unlink(lockPath); }
} });
