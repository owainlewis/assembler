import { test } from "node:test";
import assert from "node:assert/strict";
import { feedback } from "../src/github.js";

function review(id: number, state: string, login = "alice", commit_id = "head", body = "") {
  return { id, state, user: { login }, commit_id, body };
}

async function reviewFeedback(reviews: ReturnType<typeof review>[]) {
  const ctx: any = {
    exec: async (command: string[]) => {
      let response: unknown;
      if (command[1] === "pr") response = { state: "OPEN", headRefOid: "head" };
      else if (command[2] === "graphql") response = {
        data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } },
      };
      else if (command[2] === "repos/owner/repo/pulls/7/reviews") response = reviews.map(review => [review]);
      else if (command[2] === "repos/owner/repo/issues/7/comments") response = [[]];
      else throw new Error(`Unexpected command: ${command.join(" ")}`);
      return { stdout: JSON.stringify(response) };
    },
  };
  return (await feedback(ctx, "owner/repo", 7)).items;
}

test("approval supersedes the same reviewer's changes request on the current head", async () => {
  assert.deepEqual(await reviewFeedback([review(1, "CHANGES_REQUESTED"), review(2, "APPROVED")]), []);
});

test("a remaining changes request produces feedback even without a body", async () => {
  assert.deepEqual(await reviewFeedback([review(1, "CHANGES_REQUESTED")]), [{
    id: "review-1", body: "Changes requested", fingerprint: JSON.stringify([1, "", "CHANGES_REQUESTED"]),
  }]);
});

test("another reviewer's approval does not supersede a changes request", async () => {
  const items = await reviewFeedback([review(1, "CHANGES_REQUESTED"), review(2, "APPROVED", "bob")]);
  assert.deepEqual(items.map(item => [item.id, item.body]), [["review-1", "Changes requested"]]);
});

test("reviews on a different commit do not supersede current-head feedback", async () => {
  const items = await reviewFeedback([review(1, "CHANGES_REQUESTED"), review(2, "APPROVED", "alice", "other")]);
  assert.deepEqual(items.map(item => item.id), ["review-1"]);
});

test("only the latest comment with a body produces review feedback", async () => {
  const items = await reviewFeedback([review(1, "CHANGES_REQUESTED"), review(2, "COMMENTED", "alice", "head", "Please clarify")]);
  assert.deepEqual(items.map(item => [item.id, item.body]), [["review-2", "Please clarify"]]);
  assert.deepEqual(await reviewFeedback([review(1, "COMMENTED")]), []);
});

test("a newer changes request supersedes approval and preserves its body", async () => {
  assert.deepEqual(await reviewFeedback([
    review(1, "APPROVED"),
    review(2, "CHANGES_REQUESTED", "alice", "head", "Handle the empty input"),
  ]), [{
    id: "review-2", body: "Handle the empty input",
    fingerprint: JSON.stringify([2, "Handle the empty input", "CHANGES_REQUESTED"]),
  }]);
});

test("reviews on other commits do not produce review feedback", async () => {
  assert.deepEqual(await reviewFeedback([
    review(1, "CHANGES_REQUESTED", "alice", "other"),
    review(2, "COMMENTED", "bob", "other", "An old comment"),
  ]), []);
});

test("latest non-actionable reviews supersede older review feedback", async () => {
  for (const state of ["APPROVED", "DISMISSED", "COMMENTED"]) {
    assert.deepEqual(await reviewFeedback([
      review(1, "CHANGES_REQUESTED"),
      review(2, state),
    ]), [], state);
  }
});

test("pending drafts do not supersede submitted review feedback", async () => {
  for (const state of ["CHANGES_REQUESTED", "COMMENTED"]) {
    const submitted = review(1, state, "alice", "head", "Handle the empty input");
    assert.deepEqual(await reviewFeedback([
      submitted,
      review(2, "PENDING", "alice", "head", "Unsubmitted draft"),
    ]), [{
      id: "review-1", body: submitted.body,
      fingerprint: JSON.stringify([1, submitted.body, state]),
    }], state);
  }
  assert.deepEqual(await reviewFeedback([review(1, "PENDING", "alice", "head", "Draft")]), []);
});
