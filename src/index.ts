import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface Harness { command: string[]; input?: "stdin" | "argument" }
export interface Config {
  agent: string;
  agents: Record<string, Harness>;
  checks: string[][];
  maxRepairs: number;
  timeoutMs: number;
}
export interface Result { exitCode: number; stdout: string; stderr: string; log: string }
export interface Row { name: string; status: "running" | "passed" | "failed"; started: number; durationMs?: number; error?: string }
export interface Context {
  task: string; project: string; config: Config; signal: AbortSignal;
  step<T>(name: string, action: () => Promise<T>): Promise<T>;
  exec(command: string[], options?: { input?: string; allowFailure?: boolean }): Promise<Result>;
  agent(prompt: string): Promise<Result>;
}
export type Workflow = (context: Context) => Promise<void>;
export const defineWorkflow = (workflow: Workflow): Workflow => workflow;

export const defaults: Config = {
  agent: "codex",
  agents: {
    codex: { command: ["codex", "exec", "--sandbox", "workspace-write", "-"], input: "stdin" },
    claude: { command: ["claude", "-p", "{prompt}"], input: "argument" },
  },
  checks: [], maxRepairs: 3, timeoutMs: 30 * 60_000,
};

export function validateConfig(value: Config): Config {
  const command = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === "string") && v[0].length > 0;
  if (!value || typeof value.agent !== "string" || !value.agents || !value.agents[value.agent]) throw new Error("Select a configured agent");
  for (const [name, h] of Object.entries(value.agents)) {
    if (!h || !command(h.command) || (h.input !== undefined && !["stdin", "argument"].includes(h.input))) throw new Error(`Invalid harness: ${name}`);
    if (h.input === "argument" && !h.command.slice(1).some(x => x.includes("{prompt}"))) throw new Error(`${name}: argument input requires {prompt}`);
    if (h.command[0].includes("{prompt}")) throw new Error("Prompt cannot be an executable");
  }
  if (!Array.isArray(value.checks) || !value.checks.every(command)) throw new Error("checks must be arrays of executable and arguments");
  if (!Number.isInteger(value.maxRepairs) || value.maxRepairs < 0 || value.maxRepairs > 20) throw new Error("maxRepairs must be 0..20");
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0) throw new Error("timeoutMs must be positive");
  return value;
}

export function harnessInput(harness: Harness, prompt: string) {
  return harness.input === "argument"
    ? { command: harness.command.map((arg, i) => i ? arg.replaceAll("{prompt}", () => prompt) : arg), input: undefined }
    : { command: harness.command, input: prompt };
}

export async function execute(command: string[], cwd: string, log: string, signal: AbortSignal, timeoutMs: number, input?: string): Promise<Result> {
  if (signal.aborted) throw new Error("Cancelled");
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, shell: false, detached: process.platform !== "win32", stdio: "pipe" });
    let stdout = "", stderr = "", stopped = "";
    let killer: NodeJS.Timeout | undefined;
    const kill = (sig: NodeJS.Signals) => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch { /* already exited */ }
    };
    const stop = (reason: string) => { if (stopped) return; stopped = reason; kill("SIGTERM"); killer = setTimeout(() => kill("SIGKILL"), 2000); };
    const abort = () => stop("Cancelled");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("Command timed out"), timeoutMs);
    const clean = () => { clearTimeout(timer); if (killer) clearTimeout(killer); signal.removeEventListener("abort", abort); };
    const capture = (channel: string, data: Buffer) => {
      const text = data.toString();
      try { appendFileSync(log, `[${channel}] ${text}`, { mode: 0o600 }); }
      catch { stop("Cannot write command log"); }
      // Bound in-memory feedback; complete output remains on disk.
      if (channel === "stdout") stdout = (stdout + text).slice(-64_000);
      else stderr = (stderr + text).slice(-64_000);
    };
    child.stdout.on("data", data => capture("stdout", data));
    child.stderr.on("data", data => capture("stderr", data));
    child.stdin.on("error", () => { /* process can exit before consuming input */ });
    child.once("error", error => { clean(); reject(error); });
    child.once("close", (code, sig) => {
      clean();
      if (stopped) reject(new Error(stopped));
      else resolve({ exitCode: code ?? (sig ? 128 : 1), stdout, stderr, log });
    });
    child.stdin.end(input);
  });
}

export async function runWorkflow(workflow: Workflow, options: {
  task: string; project: string; config: Config; signal?: AbortSignal;
  update?: (rows: Row[]) => void;
}) {
  const config = validateConfig(options.config);
  const id = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const directory = join(options.project, ".assembler", "runs", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const rows: Row[] = [];
  const signal = options.signal ?? new AbortController().signal;
  let sequence = 0;
  const save = (status: string) => writeFileSync(join(directory, "run.json"), JSON.stringify({ id, status, agent: config.agent, rows }, null, 2), { mode: 0o600 });
  const context: Context = {
    task: options.task, project: options.project, config, signal,
    async step(name, action) {
      if (signal.aborted) throw new Error("Cancelled");
      const row: Row = { name, status: "running", started: Date.now() };
      rows.push(row); save("running"); options.update?.(rows);
      try { const result = await action(); row.status = "passed"; return result; }
      catch (error) { row.status = "failed"; row.error = String(error); throw error; }
      finally { row.durationMs = Date.now() - row.started; save("running"); options.update?.(rows); }
    },
    async exec(command, args = {}) {
      const result = await execute(command, options.project, join(directory, `${++sequence}.log`), signal, config.timeoutMs, args.input);
      if (result.exitCode !== 0 && !args.allowFailure) throw new Error(`Command failed (${result.exitCode}): ${command[0]}. Log: ${result.log}`);
      return result;
    },
    async agent(prompt) { const input = harnessInput(config.agents[config.agent], prompt); return context.exec(input.command, { input: input.input }); },
  };
  try { save("running"); await workflow(context); save("completed"); }
  catch (error) { save(signal.aborted ? "cancelled" : "failed"); throw new Error(`${String(error)}\nRun: ${directory}`, { cause: error }); }
  return directory;
}
