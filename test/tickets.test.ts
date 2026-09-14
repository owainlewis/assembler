import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchTicket, shellCommand, linearIssue, fetchResultSchema } from "../src/tickets.js";
import { z } from "../src/index.js";
import { readCommandDecision } from "../src/agents.js";

const task = { identifier: "123", title: "Fix", description: "Original description", comments: ["Original comment"],
  acceptanceCriteria: ["No crash"], url: "https://github.com/owner/repo/issues/123", state: "open", complete: true };
function fixture(overrides: Record<string, unknown> = {}, options: { blocked?: boolean; noCalls?: boolean; failedCLI?: boolean } = {}) {
  const outputs: any[] = [], requests: any[] = [];
  const ctx: any = {
    step: async (_name: string, action: () => Promise<unknown>) => action(),
    exec: () => { throw new Error("Script must not fetch tickets itself"); },
    output: (name: string, value: unknown) => outputs.push({ name, value }),
    agent: async (name: string, settings: any) => {
      requests.push({ name, ...settings });
      return { data: { status: options.blocked ? "blocked" : "ready", reason: options.blocked ? "CLI unavailable or unauthenticated" : "Fetched", task: options.blocked ? null : { ...task, ...overrides } },
        commands: options.noCalls ? [] : settings.readCommands.map((command: string) => ({ command, exitCode: options.failedCLI ? 1 : 0 })) };
    },
  };
  return { ctx, outputs, requests };
}
test("GitHub task is fetched by a named CLI agent and saved before delivery", async () => {
  const { ctx, outputs, requests } = fixture();
  const ticket = await fetchTicket(ctx, "123", "owner/repo");
  assert.equal(requests[0].name, "Fetch task");
  assert.equal(requests[0].readOnly, true);
  assert.deepEqual(requests[0].readCommands, ["gh issue view 123 --repo owner/repo --json number,title,body,url,state,comments"]);
  assert.match(requests[0].prompt, /CLI ONLY/);
  assert.match(ticket.body, /Original description/);
  assert.match(ticket.body, /Original comment/);
  assert.deepEqual(outputs.at(-1), { name: "Task", value: ticket });
});
test("Linear uses configurable CLI commands, with no HTTP adapter or MCP", async () => {
  const { ctx, requests } = fixture({ identifier: "ENG-123", url: "https://linear.app/team/issue/ENG-123/fix" });
  const ticket = await fetchTicket(ctx, "ENG-123", "owner/repo", [["my-linear", "show", "{ticket}"]]);
  assert.equal(ticket.key, "eng-123");
  assert.deepEqual(requests[0].readCommands, ["my-linear show ENG-123"]);
  assert.equal(linearIssue(ticket.url), "ENG-123");
});
test("wrong identities, closed issues and incomplete snapshots stop the workflow", async () => {
  for (const override of [{ identifier: "124" }, { url: "https://github.com/other/repo/issues/123" }, { state: "closed" }, { complete: false }]) {
    const { ctx, outputs } = fixture(override);
    await assert.rejects(fetchTicket(ctx, "123", "owner/repo"), /match|incomplete|closed/);
    assert.ok(!outputs.some(output => output.name === "Task"));
  }
});
test("missing authentication, failed CLI or agent claims without CLI evidence cannot succeed", async () => {
  for (const options of [{ blocked: true }, { noCalls: true }, { failedCLI: true }]) {
    const { ctx } = fixture({}, options);
    await assert.rejects(fetchTicket(ctx, "123", "owner/repo"), /blocked|CLI evidence/);
  }
});
test("invalid references fail before agent invocation", async () => {
  for (const reference of ["0", "999999999999999999999999999", "not-a-ticket", "https://github.com/other/repo/issues/1"]) {
    const { ctx, requests } = fixture();
    await assert.rejects(fetchTicket(ctx, reference, "owner/repo"));
    assert.equal(requests.length, 0);
  }
});
test("fetch schema avoids provider-unsupported URL formats but still validates URLs locally", async () => {
  assert.ok(!JSON.stringify(z.toJSONSchema(fetchResultSchema, { target: "draft-7" })).includes('"format":"uri"'));
  await assert.rejects(fetchTicket(fixture({ url: "not a URL" }).ctx, "123", "owner/repo"), /URL does not match/);
  await assert.rejects(fetchTicket(fixture({ url: "123" }).ctx, "123", "owner/repo"), /URL does not match/);
  await assert.rejects(fetchTicket(fixture({ identifier: "ENG-123", url: "ENG-123" }).ctx, "ENG-123", "owner/repo"), /URL does not match/);
});
test("CLI quoting is literal and Claude's hook rejects extra shell operations", () => {
  const command = shellCommand(["linear", "issue", "view", "ENG-123"]);
  assert.equal(readCommandDecision([command], command), "allow");
  for (const value of [command + "; touch bad", command + " > file", command + " | sh", "linear issue delete ENG-123", undefined])
    assert.equal(readCommandDecision([command], value), "deny");
  assert.equal(shellCommand(["tool", "$(touch bad)"]), "tool '$(touch bad)'");
  assert.equal(shellCommand(["tool", "a'b"]), "tool 'a'\\''b'");
});
