import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAndRepair } from "../examples/lib/engineering.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaults, runWorkflow } from "../src/index.js";

function fixture(codes: number[]) {
  const evidence: any[] = [], prompts: string[] = [];
  let calls = 0;
  const ctx: any = {
    step: async (_name: string, run: () => Promise<unknown>) => run(),
    output: (_name: string, value: unknown) => evidence.push(value),
    exec: async () => ({ exitCode: codes[calls++] ?? 0, stdout: "output", stderr: "diagnostic", log: `check-${calls}.log`, stdoutTruncated: true }),
    agent: async (_name: string, options: { prompt: string }) => { prompts.push(options.prompt); },
  };
  return { ctx, evidence, prompts, calls: () => calls };
}

test("passing checks retain evidence and never need a reviewer", async () => {
  const f = fixture([0]);
  const results = await validateAndRepair(f.ctx, { task: "fix", checks: [["npm", "test"]], maxRepairs: 0 });
  assert.equal(results?.[0].exitCode, 0);
  assert.deepEqual(results?.[0].command, ["npm", "test"]);
  assert.equal(f.prompts.length, 0);
  assert.deepEqual(f.evidence[0], results);
});

test("repair receives successful and failed evidence with full-log references", async () => {
  const f = fixture([0, 1, 0, 0]);
  const results = await validateAndRepair(f.ctx, { task: "fix", checks: [["typecheck"], ["tests"]], maxRepairs: 1 });
  assert.equal(f.calls(), 4);
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0], /"exitCode":0/);
  assert.match(f.prompts[0], /"exitCode":1/);
  assert.match(f.prompts[0], /check-2.log/);
  assert.match(f.prompts[0], /"stdoutTruncated":true/);
  assert.ok(results?.every(result => result.exitCode === 0));
});

test("final repair is checked and a failing final result cannot pass", async () => {
  const f = fixture([1, 1]);
  await assert.rejects(validateAndRepair(f.ctx, { task: "fix", checks: [["test"]], maxRepairs: 1 }), /budget exhausted/);
  assert.equal(f.calls(), 2);
  assert.equal(f.prompts.length, 1);
});

test("changing log filenames does not conceal stalled repairs", async () => {
  const f = fixture([1, 1, 1]);
  await assert.rejects(validateAndRepair(f.ctx, { task: "fix", checks: [["test"]], maxRepairs: 3 }), /No progress/);
  assert.equal(f.calls(), 2);
  assert.equal(f.prompts.length, 1);
});

test("real Git validation includes new files and rejects check-time mutations", async () => {
  const project = await mkdtemp(join(tmpdir(), "assembler-validation-"));
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: project });
  try {
    await git("init");
    await writeFile(join(project, ".gitignore"), ".assembler/\n");
    await writeFile(join(project, "new.txt"), "candidate");
    const run = await runWorkflow(async ctx => {
      await validateAndRepair(ctx, { task: "validate", base: "HEAD", maxRepairs: 0,
        checks: [[process.execPath, "-e", "console.log('verified candidate')"]] });
    }, { project, config: defaults });
    const record = JSON.parse(await readFile(join(run, "run.json"), "utf8"));
    const evidence = record.outputs.find((item: any) => item.name === "Validated candidate").value;
    assert.match(evidence.tree, /^[a-f0-9]{40,64}$/);
    assert.match((await git("ls-tree", evidence.tree)).stdout, /new.txt/);
    assert.equal(evidence.checks[0].stdout.trim(), "verified candidate");
    await assert.rejects(runWorkflow(async ctx => {
      await validateAndRepair(ctx, { task: "validate", base: "HEAD", maxRepairs: 0,
        checks: [[process.execPath, "-e", "require('node:fs').writeFileSync('new.txt', 'changed')"]] });
    }, { project, config: defaults }), /Checks changed the candidate/);
  } finally { await rm(project, { recursive: true }); }
});
