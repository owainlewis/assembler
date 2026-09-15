import { type Context } from "./index.js";
import { jsonCommand, pause } from "./engineering.js";

export interface FeedbackItem { id: string; body: string; threadId?: string; fingerprint: string }
export interface Feedback { head: string; ci: "passed" | "failed" | "pending"; items: FeedbackItem[]; checks: unknown[]; reviewDecision: string; isDraft: boolean; mergeable: string }
export function checkState(checks: any[]): Feedback["ci"] {
  if (!checks.length || checks.some(check => check.status ? check.status !== "COMPLETED" : !["SUCCESS", "FAILURE", "ERROR"].includes(check.state))) return "pending";
  return checks.every(check => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? check.state)) ? "passed" : "failed";
}
export async function feedback(ctx: Context, repo: string, number: number): Promise<Feedback> {
  const pr = await jsonCommand(ctx, ["gh", "pr", "view", String(number), "--repo", repo, "--json", "headRefOid,state,statusCheckRollup,reviewDecision,isDraft,mergeable"]);
  if (pr.state !== "OPEN") throw new Error("PR is no longer open");
  const [owner, name] = repo.split("/");
  const response = await jsonCommand(ctx, ["gh", "api", "graphql", "-f", "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved comments(first:100){pageInfo{hasNextPage} nodes{id body}}}}}}}", "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`]);
  if (response.errors?.length) throw new Error("Unable to read PR review threads");
  const threads = response.data.repository.pullRequest.reviewThreads;
  if (threads.pageInfo.hasNextPage || threads.nodes.some((thread: any) => thread.comments.pageInfo.hasNextPage)) throw new Error("Review exceeds pagination limit; manual triage required");
  const items: FeedbackItem[] = threads.nodes.filter((thread: any) => !thread.isResolved).map((thread: any) => ({
    id: thread.id, threadId: thread.id, body: thread.comments.nodes.map((comment: any) => comment.body).join("\n"), fingerprint: JSON.stringify(thread.comments.nodes),
  }));
  const reviews = (await jsonCommand<any[][]>(ctx, ["gh", "api", `repos/${repo}/pulls/${number}/reviews`, "--paginate", "--slurp"])).flat();
  const latestReviews = new Map<string, any>();
  // Reviews are returned in chronological order, including superseded reviews.
  for (const review of reviews) {
    // An unsubmitted draft does not supersede the reviewer's published feedback.
    if (review.commit_id === pr.headRefOid && review.state !== "PENDING") latestReviews.set(review.user.login, review);
  }
  for (const review of latestReviews.values()) {
    if (review.state !== "CHANGES_REQUESTED" && !(review.state === "COMMENTED" && review.body)) continue;
    items.push({ id: `review-${review.id}`, body: review.body || "Changes requested", fingerprint: JSON.stringify([review.id, review.body, review.state]) });
  }
  // Issue comments may contain asynchronous review summaries as well as inline threads.
  const comments = (await jsonCommand<any[][]>(ctx, ["gh", "api", `repos/${repo}/issues/${number}/comments`, "--paginate", "--slurp"])).flat();
  for (const comment of comments) items.push({ id: `comment-${comment.id}`, body: comment.body ?? "", fingerprint: JSON.stringify([comment.id, comment.body]) });
  return { head: pr.headRefOid, ci: checkState(pr.statusCheckRollup ?? []), items, checks: pr.statusCheckRollup ?? [],
    reviewDecision: pr.reviewDecision ?? "", isDraft: pr.isDraft, mergeable: pr.mergeable };
}

export async function waitFeedback(ctx: Context, repo: string, number: number, options: { timeoutMs: number; pollMs: number; quietMs: number }) {
  const deadline = Date.now() + options.timeoutMs;
  let previous = "", changedAt = Date.now();
  while (Date.now() < deadline) {
    const current = await feedback(ctx, repo, number);
    const fingerprint = JSON.stringify(current);
    if (fingerprint !== previous) { previous = fingerprint; changedAt = Date.now(); }
    if (current.ci !== "pending" && Date.now() - changedAt >= options.quietMs) return current;
    await pause(Math.min(options.pollMs, Math.max(1, deadline - Date.now())), ctx.signal);
  }
  throw new Error("Timed out waiting for CI/review feedback; PR retained for continuation");
}
