import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, runWorkflow, RunError, z, execute } from "../src/index.js";
import { formatOutputs, formatRow } from "../src/display.js";

async function fixture(action: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "assembler-outputs-"));
  try { await action(dir); } finally { await rm(dir, { recursive: true }); }
}

test("parallel outputs retain step identity and event order", () => fixture(async project => {
  const events: any[] = [];
  const run = await runWorkflow(async ctx => {
    await Promise.all([100, 5].map((delay, index) => ctx.step("Repeated name", async () => {
      await new Promise(resolve => setTimeout(resolve, delay));
      ctx.output(`Output ${index}`, { index });
    })));
  }, { task: "task", project, config: defaults, event: event => events.push(event) });
  const record = JSON.parse(await readFile(join(run, "run.json"), "utf8"));
  assert.equal(record.outputs[0].stepId, "step-2");
  assert.equal(record.outputs[1].stepId, "step-1");
  assert.equal(record.rows.every((row: any) => row.status === "passed"), true);
  assert.deepEqual(events.map(e => e.sequence), events.map((_, index) => index + 1));
  assert.equal(events.at(-1).type, "run.finished");
}));

test("failure preserves outputs and root cause in the run record", () => fixture(async project => {
  try {
    await runWorkflow(async ctx => {
      ctx.output("Evidence", "keep me");
      await ctx.step("fail", async () => { throw new Error("root cause"); });
    }, { task: "task", project, config: defaults });
    assert.fail("must fail");
  } catch (error) {
    assert.ok(error instanceof RunError);
    assert.equal(error.record.error, "root cause");
    assert.equal(error.record.outputs[0].value, "keep me");
    assert.equal(await readFile(error.record.outputs[0].path, "utf8"), "keep me");
  }
}));

test("structured command fallback rejects JSON of the wrong shape", () => fixture(async project => {
  const config = { ...defaults, agent: "fake", agents: { fake: { command: [process.execPath, "-e", 'console.log(JSON.stringify({approved:"yes"}))'] } } };
  await assert.rejects(runWorkflow(async ctx => {
    await ctx.step("Classify", () => ctx.agentJson("task", z.object({ approved: z.boolean() })));
  }, { task: "task", project, config }), /Invalid structured/);
}));

test("structured command fallback validates and returns typed data", () => fixture(async project => {
  const config = { ...defaults, agent: "fake", agents: { fake: { command: [process.execPath, "-e", 'console.log(JSON.stringify({approved:true}))'] } } };
  await runWorkflow(async ctx => {
    const data = await ctx.agentJson("task", z.object({ approved: z.boolean() }));
    assert.equal(data.approved, true);
  }, { task: "task", project, config });
}));

test("Claude envelope is validated, including explicit provider errors", () => fixture(async project => {
  const fake = join(project, "fake.cjs");
  await writeFile(fake, `const args=process.argv; const schema=JSON.parse(args[args.indexOf('--json-schema')+1]); if(schema.$schema !== 'http://json-schema.org/draft-07/schema#') process.exit(2); console.log(JSON.stringify({structured_output:{approved:true}}));`);
  const config = { ...defaults, agent: "fake", agents: { fake: { command: [process.execPath, fake], structured: "claude" as const } } };
  await runWorkflow(async ctx => { assert.deepEqual(await ctx.agentJson("task", z.object({ approved: z.boolean() })), { approved: true }); }, { task: "task", project, config });
  await writeFile(fake, 'console.log(JSON.stringify({is_error:true,structured_output:{approved:true}}))');
  await assert.rejects(runWorkflow(async ctx => { await ctx.agentJson("task", z.object({ approved: z.boolean() })); }, { task: "task", project, config }), /successful structured result/);
}));

test("Codex adapter reads final file rather than stdout chatter", () => fixture(async project => {
  const fake = join(project, "fake.cjs");
  await writeFile(fake, `const fs=require('fs'); const args=process.argv; fs.writeFileSync(args[args.indexOf('--output-last-message')+1], JSON.stringify({approved:true})); console.log('chatter');`);
  const config = { ...defaults, agent: "fake", agents: { fake: { command: [process.execPath, fake], structured: "codex" as const } } };
  await runWorkflow(async ctx => { assert.deepEqual(await ctx.agentJson("task", z.object({ approved: z.boolean() })), { approved: true }); }, { task: "task", project, config });
}));

test("JSON failures stay parseable despite workflow console.log", () => fixture(async project => {
  await writeFile(join(project, "fail.ts"), `console.log('import chatter'); export default async ctx => { console.log('chatter'); ctx.output('Evidence', {ok: true}); throw new Error('boom'); };`);
  const result = await execute([process.execPath, "--import", "tsx", join(import.meta.dirname, "../src/cli.ts"), "run", "fail.ts", "--project", project, "--prompt", "test", "--json"], process.cwd(), join(project, "cli.log"), new AbortController().signal, 10_000);
  assert.equal(result.exitCode, 1);
  const record = JSON.parse(result.stdout);
  assert.equal(record.status, "failed"); assert.equal(record.error, "boom");
  assert.equal(record.outputs[0].value.ok, true); assert.match(result.stderr, /chatter/);
}));

test("long outputs are previewed and terminal escape codes are removed", () => {
  const value = "\x1b[2J" + "line\n".repeat(100);
  const text = formatOutputs({ schemaVersion: 1, id: "id", status: "completed", agent: "fake", rows: [], outputs: [{ id: "out", name: "Result", format: "text", path: "/tmp/out", value }] });
  assert.ok(!text.includes("\x1b")); assert.match(text, /Full output: \/tmp\/out/);
  assert.match(formatRow({ id: "1", name: "Check", status: "passed", started: 0, durationMs: 65000 }), /1m 5s/);
});

test("NDJSON is a complete ordered lifecycle on failure", () => fixture(async project => {
  await writeFile(join(project, "fail.ts"), `export default async ctx => { await ctx.step('Broken', async () => { throw new Error('deliberate'); }); };`);
  const result = await execute([process.execPath, "--import", "tsx", join(import.meta.dirname, "../src/cli.ts"), "run", "fail.ts", "--project", project, "--prompt", "test", "--events"], process.cwd(), join(project, "cli.log"), new AbortController().signal, 10_000);
  const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(events.map(event => event.type), ["run.started", "step.started", "step.finished", "run.finished"]);
  assert.equal(events.at(-1).data.status, "failed");
}));

test("CLI errors before a run still return valid JSON", () => fixture(async project => {
  const result = await execute([process.execPath, "--import", "tsx", join(import.meta.dirname, "../src/cli.ts"), "run", "--project", project, "--json"], process.cwd(), join(project, "cli.log"), new AbortController().signal, 10_000);
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stdout).run, null);
  assert.equal(JSON.parse(result.stdout).status, "failed");
}));

test("failed parallel work cancels command siblings before finalizing", () => fixture(async project => {
  await assert.rejects(runWorkflow(async ctx => {
    await Promise.all([
      ctx.step("Slow", () => ctx.exec([process.execPath, "-e", "setInterval(()=>{},1000)"])),
      ctx.step("Fail", async () => { throw new Error("stop siblings"); }),
    ]);
  }, { task: "task", project, config: defaults }), (error: unknown) => {
    assert.ok(error instanceof RunError);
    assert.equal(error.record.rows.every(row => row.status === "failed"), true);
    return true;
  });
}));
