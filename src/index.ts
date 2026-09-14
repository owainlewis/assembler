import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface Harness { command: string[]; input?: "stdin" | "argument"; structured?: "codex" | "claude" | "prompt" }
export interface Config {
  agent: string;
  agents: Record<string, Harness>;
  checks: string[][];
  maxRepairs: number;
  timeoutMs: number;
}
export { z };
export interface Result { exitCode: number; stdout: string; stderr: string; log: string; stdoutTruncated?: boolean; stderrTruncated?: boolean }
export interface Row { id: string; parentId?: string; name: string; status: "running" | "passed" | "failed"; started: number; durationMs?: number; error?: string }
export interface Output { id: string; stepId?: string; name: string; format: "text" | "json"; path: string; value: unknown }
export interface RunRecord { schemaVersion: 1; id: string; status: string; agent: string; rows: Row[]; outputs: Output[]; error?: string }
export interface RunEvent { schemaVersion: 1; sequence: number; time: string; type: string; runId: string; data: unknown }
export class RunError extends Error {
  constructor(message: string, public run: string, public record: RunRecord) { super(message); }
}
export interface Context {
  task: string; project: string; config: Config; signal: AbortSignal;
  step<T>(name: string, action: () => Promise<T>): Promise<T>;
  exec(command: string[], options?: { input?: string; allowFailure?: boolean }): Promise<Result>;
  agent(prompt: string): Promise<Result>;
  agentJson<S extends z.ZodType>(prompt: string, schema: S): Promise<z.output<S>>;
  output(name: string, value: unknown): Output;
}
export type Workflow = (context: Context) => Promise<void>;
export const defineWorkflow = (workflow: Workflow): Workflow => workflow;

export const defaults: Config = {
  agent: "codex",
  agents: {
    codex: { command: ["codex", "exec", "--sandbox", "workspace-write", "-"], input: "stdin", structured: "codex" },
    claude: { command: ["claude", "-p", "{prompt}"], input: "argument", structured: "claude" },
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
    if (h.structured && !["codex", "claude", "prompt"].includes(h.structured)) throw new Error(`Invalid structured output adapter: ${name}`);
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
    let stdout = "", stderr = "", stopped = "", stdoutTruncated = false, stderrTruncated = false;
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
      if (channel === "stdout") { stdoutTruncated ||= stdout.length + text.length > 64_000; stdout = (stdout + text).slice(-64_000); }
      else { stderrTruncated ||= stderr.length + text.length > 64_000; stderr = (stderr + text).slice(-64_000); }
    };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", data => capture("stdout", data));
    child.stderr.on("data", data => capture("stderr", data));
    child.stdin.on("error", () => { /* process can exit before consuming input */ });
    child.once("error", error => { clean(); reject(error); });
    child.once("close", (code, sig) => {
      clean();
      if (stopped) reject(new Error(stopped));
      else resolve({ exitCode: code ?? (sig ? 128 : 1), stdout, stderr, log, stdoutTruncated, stderrTruncated });
    });
    child.stdin.end(input);
  });
}

export async function runWorkflow(workflow: Workflow, options: {
  task: string; project: string; config: Config; signal?: AbortSignal;
  update?: (rows: Row[]) => void;
  event?: (event: RunEvent) => void;
}) {
  const config = validateConfig(options.config);
  const id = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const directory = join(options.project, ".assembler", "runs", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const rows: Row[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const signal = controller.signal;
  const storage = new AsyncLocalStorage<string>();
  const pending = new Set<Promise<unknown>>();
  let sequence = 0, eventSequence = 0, finished = false;
  const record: RunRecord = { schemaVersion: 1, id, status: "running", agent: config.agent, rows, outputs: [] };
  const save = () => {
    writeFileSync(join(directory, "run.json.tmp"), JSON.stringify(record, null, 2), { mode: 0o600 });
    renameSync(join(directory, "run.json.tmp"), join(directory, "run.json"));
  };
  const emit = (type: string, data: unknown) => {
    const event: RunEvent = { schemaVersion: 1, sequence: ++eventSequence, time: new Date().toISOString(), type, runId: id, data };
    appendFileSync(join(directory, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
    options.event?.(event);
  };
  const context: Context = {
    task: options.task, project: options.project, config, signal,
    step(name, action) {
      if (finished) throw new Error("Run already finished");
      if (signal.aborted) throw new Error("Cancelled");
      const row: Row = { id: `step-${rows.length + 1}`, parentId: storage.getStore(), name, status: "running", started: Date.now() };
      rows.push(row); save(); emit("step.started", { ...row }); options.update?.(rows);
      const promise = storage.run(row.id, async () => {
        try { const result = await action(); row.status = "passed"; return result; }
        catch (error) { row.status = "failed"; row.error = error instanceof Error ? error.message : String(error); throw error; }
        finally { row.durationMs = Date.now() - row.started; save(); emit("step.finished", { ...row }); options.update?.(rows); }
      });
      pending.add(promise);
      void promise.then(() => pending.delete(promise), () => pending.delete(promise));
      return promise;
    },
    async exec(command, args = {}) {
      if (finished) throw new Error("Run already finished");
      const log = join(directory, `${++sequence}.log`);
      emit("command.started", { stepId: storage.getStore(), executable: command[0], log });
      const result = await execute(command, options.project, log, signal, config.timeoutMs, args.input);
      emit("command.finished", { stepId: storage.getStore(), exitCode: result.exitCode, log });
      if (result.exitCode !== 0 && !args.allowFailure) throw new Error(`Command failed (${result.exitCode}): ${command[0]}. Log: ${result.log}`);
      return result;
    },
    async agent(prompt) { const input = harnessInput(config.agents[config.agent], prompt); return context.exec(input.command, { input: input.input }); },
    async agentJson(prompt, schema) {
      const harness = config.agents[config.agent];
      const schemaText = JSON.stringify(z.toJSONSchema(schema, { target: "draft-7" }));
      const prepared = harnessInput(harness, `${prompt}\n\nReturn ONLY a JSON value matching this schema. No markdown fences or commentary.\n${schemaText}`);
      const command = [...prepared.command];
      let finalFile: string | undefined;
      if (harness.structured === "codex") {
        const artifact = randomUUID();
        const schemaFile = join(directory, `${artifact}.schema.json`);
        finalFile = join(directory, `${artifact}.result.json`);
        writeFileSync(schemaFile, schemaText, { mode: 0o600 });
        command.push("--output-schema", schemaFile, "--output-last-message", finalFile);
      } else if (harness.structured === "claude") {
        command.push("--output-format", "json", "--json-schema", schemaText);
      }
      const result = await context.exec(command, { input: prepared.input });
      if (!finalFile && result.stdoutTruncated) throw new Error(`Structured output exceeded capture limit. Log: ${result.log}`);
      try {
        let value = JSON.parse(finalFile ? readFileSync(finalFile, "utf8") : result.stdout);
        if (harness.structured === "claude") {
          if (value.is_error || !Object.hasOwn(value, "structured_output")) throw new Error("Claude did not return a successful structured result");
          value = value.structured_output;
        }
        return schema.parse(value);
      }
      catch (error) { throw new Error(`Invalid structured agent output: ${error instanceof Error ? error.message : String(error)}. Log: ${result.log}`); }
    },
    output(name, value) {
      if (finished) throw new Error("Run already finished");
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      if (text === undefined) throw new Error("Output must be text or JSON-serializable data");
      const outputId = `output-${record.outputs.length + 1}`;
      const format = typeof value === "string" ? "text" : "json";
      const path = join(directory, `${outputId}.${format === "text" ? "txt" : "json"}`);
      writeFileSync(path, text, { mode: 0o600 });
      const output: Output = { id: outputId, stepId: storage.getStore(), name, format, path, value: format === "text" ? text : JSON.parse(text) };
      record.outputs.push(output); save(); emit("output.created", output);
      return output;
    },
  };
  try {
    save(); emit("run.started", { agent: config.agent });
    await workflow(context);
    if (pending.size) throw new Error("Workflow returned with unfinished steps; await all steps");
    if (signal.aborted) throw new Error("Cancelled");
    record.status = "completed";
  } catch (error) {
    record.status = options.signal?.aborted ? "cancelled" : "failed";
    record.error = error instanceof Error ? error.message : String(error);
    controller.abort();
    await Promise.allSettled([...pending]);
  } finally {
    finished = true; options.signal?.removeEventListener("abort", abort);
    save(); emit("run.finished", record);
  }
  if (record.status !== "completed") throw new RunError(record.error ?? "Run failed", directory, record);
  return directory;
}
