import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, harnessInput, runWorkflow, defaults, validateConfig } from "../src/index.js";
import fixChecks from "../src/fix-checks.js";

test("prompts remain literal arguments, including shell syntax", async () => {
  const prompt = '`touch bad` $(echo bad) "quotes"\nline';
  const prepared = harnessInput({ command: [process.execPath, "-e", "console.log(process.argv[1])", "{prompt}"], input: "argument" }, prompt);
  const dir = await mkdtemp(join(tmpdir(), "assembler-test-"));
  try {
    const result = await execute(prepared.command, dir, join(dir, "log"), new AbortController().signal, 1000);
    assert.equal(result.stdout.trim(), prompt);
  } finally { await rm(dir, { recursive: true }); }
});

test("stdin, stderr and nonzero exit are preserved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembler-test-"));
  try {
    const result = await execute([process.execPath, "-e", "process.stdin.pipe(process.stdout); console.error('failure'); process.exitCode=7"], dir, join(dir, "log"), new AbortController().signal, 1000, "hello");
    assert.equal(result.exitCode, 7); assert.equal(result.stdout, "hello"); assert.match(result.stderr, /failure/);
  } finally { await rm(dir, { recursive: true }); }
});

test("hung processes time out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembler-test-"));
  try { await assert.rejects(execute([process.execPath, "-e", "setInterval(()=>{},1000)"], dir, join(dir, "log"), new AbortController().signal, 50), /timed out/); }
  finally { await rm(dir, { recursive: true }); }
});

test("run records failures and step outcomes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembler-test-"));
  try {
    const run = await runWorkflow(async ctx => { await ctx.step("Check", () => ctx.exec([process.execPath, "-e", "console.log('ok')"])); }, { task: "task", project: dir, config: defaults });
    const saved = JSON.parse(await readFile(join(run, "run.json"), "utf8"));
    assert.equal(saved.status, "completed"); assert.equal(saved.rows[0].status, "passed");
    await assert.rejects(runWorkflow(async ctx => { await ctx.step("Fail", () => ctx.exec([process.execPath, "-e", "process.exit(2)"])); }, { task: "task", project: dir, config: defaults }), /Command failed/);
  } finally { await rm(dir, { recursive: true }); }
});

test("fix-checks repairs failures and verifies the last repair", async () => {
  let agents = 0, checks = 0;
  await fixChecks({ task: "fix", input: { checks: [["test"]], maxRepairs: 1 }, project: ".", config: defaults, signal: new AbortController().signal,
    output: () => ({}),
    step: async (_, action) => action(),
    agent: async () => { agents++; return { exitCode: 0, stdout: "", stderr: "", log: "" }; },
    exec: async () => ({ exitCode: checks++ === 0 ? 1 : 0, stdout: "", stderr: "", log: "" }),
  });
  assert.equal(agents, 1); assert.equal(checks, 2);
});

test("invalid harness configuration fails before execution", () => {
  assert.throws(() => validateConfig({ ...defaults, agent: "missing" }), /configured agent/);
  assert.throws(() => validateConfig({ ...defaults, agents: { codex: { command: ["codex"], input: "argument" } } }), /requires/);
});

test("CLI loads a TypeScript workflow from the selected project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembler-cli-"));
  try {
    await writeFile(join(dir, "workflow.ts"), `export default async function(ctx: any) { ctx.output("cwd", process.cwd()); await ctx.step("Agent", () => ctx.agent(ctx.task)); }`);
    await writeFile(join(dir, "assembler.json"), JSON.stringify({ agent: "fake", agents: { fake: { command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"], input: "stdin" } } }));
    const result = await execute([process.execPath, "--import", "tsx", join(import.meta.dirname, "../src/cli.ts"), "run", "workflow.ts", "--project", dir, "--prompt", "literal task", "--json"], process.cwd(), join(dir, "cli.log"), new AbortController().signal, 10_000);
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "completed");
    assert.equal(report.outputs.find((output: any) => output.name === 'cwd').value, await realpath(dir));
    assert.match(await readFile(join(report.run, "1.log"), "utf8"), /literal task/);
  } finally { await rm(dir, { recursive: true }); }
});

test("cancellation stops an active process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembler-cancel-"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  try { await assert.rejects(execute([process.execPath, "-e", "setInterval(()=>{},1000)"], dir, join(dir, "log"), controller.signal, 5000), /Cancelled/); }
  finally { clearTimeout(timer); await rm(dir, { recursive: true }); }
});

test("fix-checks cannot report success when its repair budget is exhausted", async () => {
  await assert.rejects(fixChecks({ task: "fix", input: { checks: [["test"]], maxRepairs: 0 }, project: ".", config: defaults, signal: new AbortController().signal,
    step: async (_, action) => action(),
    agent: async () => ({ exitCode: 0, stdout: "", stderr: "", log: "" }),
    exec: async () => ({ exitCode: 1, stdout: "bad", stderr: "", log: "" }),
  }), /budget exhausted/);
});
