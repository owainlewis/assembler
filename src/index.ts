import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runSDK, type AgentResult } from "./agents.js";
export type { AgentResult } from "./agents.js";

export interface Harness { provider?: "codex" | "claude" | "command"; model?: string; executable?: string; command?: string[]; input?: "stdin" | "argument"; structured?: "codex" | "claude" | "prompt" }
export interface Config {
  agent: string;
  agents: Record<string, Harness>;
  timeoutMs: number;
}
export { z };
export interface Result { exitCode: number; stdout: string; stderr: string; log: string; stdoutTruncated?: boolean; stderrTruncated?: boolean }
export interface Row { id: string; parentId?: string; name: string; status: "running" | "passed" | "failed"; started: number; durationMs?: number; error?: string }
export interface Output { id: string; stepId?: string; name: string; format: "text" | "json"; path: string; value: unknown; detail?: boolean }
const blockedTag = Symbol.for('assembler.WorkflowBlocked');
export class WorkflowBlocked extends Error { readonly [blockedTag] = true; }
export interface RunRecord { schemaVersion: 1; id: string; status: string; agent: string; rows: Row[]; outputs: Output[]; error?: string; workflow?: string; createdAt?: string; cleanup?: string }
export interface RunEvent { schemaVersion: 1; sequence: number; time: string; type: string; runId: string; data: unknown }
export class RunError extends Error {
  constructor(message: string, public run: string, public record: RunRecord) { super(message); }
}
export interface AgentOptions<S extends z.ZodType = z.ZodType> { prompt: string; schema?: S; agent?: string; readOnly?: boolean; readCommands?: string[]; timeoutMs?: number }
export interface AgentCall {
  (prompt: string): Promise<Result>;
  (name: string, options: AgentOptions & { schema?: undefined }): Promise<AgentResult>;
  <S extends z.ZodType>(name: string, options: AgentOptions<S> & { schema: S }): Promise<AgentResult & { data: z.output<S> }>;
}
export interface Context<I = unknown> {
  task: string; project: string; config: Config; signal: AbortSignal;
  input: I;
  at(project: string): Context<I>;
  step<T>(name: string, action: () => Promise<T>): Promise<T>;
  exec(command: string[], options?: { input?: string; allowFailure?: boolean }): Promise<Result>;
  agent: AgentCall;
  agentJson<S extends z.ZodType>(prompt: string, schema: S): Promise<z.output<S>>;
  output(name: string, value: unknown, options?: { detail?: boolean }): Output;
}
export type Workflow = (context: Context<any>) => Promise<void>;
export function defineWorkflow(workflow: Workflow): Workflow;
export function defineWorkflow<S extends z.ZodType>(definition: { input: S; run: (context: Context<z.output<S>>) => Promise<void> }): Workflow;
export function defineWorkflow(definition: Workflow | { input: z.ZodType; run: Workflow }): Workflow {
  if (typeof definition === "function") return definition;
  return async ctx => {
    const input = definition.input.parse(ctx.input);
    const scoped = (context: Context): Context => ({ ...context, input, at: project => scoped(context.at(project)) });
    await definition.run(scoped(ctx));
  };
}

export const defaults: Config = {
  agent: "codex",
  agents: {
    codex: { provider: "codex" },
    claude: { provider: "claude" },
  },
  timeoutMs: 30 * 60_000,
};

export function validateConfig(value: Config): Config {
  const command = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === "string") && v[0].length > 0;
  if (!value || typeof value.agent !== "string" || !value.agents || !value.agents[value.agent]) throw new Error("Select a configured agent");
  for (const [name, h] of Object.entries(value.agents)) {
    if (h?.provider === "codex" || h?.provider === "claude") {
      if (h.command) throw new Error(`${name}: use provider command for a custom command`);
      if (h.input || h.structured) throw new Error(`${name}: input/structured are command adapter options`);
      if ([h.model, h.executable].some(value => value !== undefined && (typeof value !== "string" || !value.trim()))) throw new Error(`${name}: model/executable must be nonempty strings`);
      continue;
    }
    if (h?.provider && h.provider !== "command") throw new Error(`Unknown provider: ${name}`);
    if (!h || !command(h.command) || (h.input !== undefined && !["stdin", "argument"].includes(h.input))) throw new Error(`Invalid harness: ${name}`);
    if (h.input === "argument" && !h.command.slice(1).some(x => x.includes("{prompt}"))) throw new Error(`${name}: argument input requires {prompt}`);
    if (h.command[0].includes("{prompt}")) throw new Error("Prompt cannot be an executable");
    if (h.structured && !["codex", "claude", "prompt"].includes(h.structured)) throw new Error(`Invalid structured output adapter: ${name}`);
  }
  if ("checks" in value || "maxRepairs" in value) throw new Error("Move checks/maxRepairs from runtime config into workflow inputs");
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0) throw new Error("timeoutMs must be positive");
  return value;
}

export function harnessInput(harness: Harness, prompt: string) {
  if (!harness.command) throw new Error("Command harness requires command");
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
    // Do not cancel escalation when the direct child exits: descendants may
    // have separate stdio and still be alive in the process group.
    const clean = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
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
  task?: string; input?: unknown; project: string; config: Config; signal?: AbortSignal;
  update?: (rows: Row[]) => void;
  event?: (event: RunEvent) => void;
  id?: string; workflowName?: string; createdAt?: string;
  interrupted?: () => boolean;
}) {
  const config = validateConfig(options.config);
  const id = options.id ?? `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) throw new Error('Invalid run ID');
  const directory = join(options.project, ".assembler", "runs", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const rows: Row[] = [];
  const controller = new AbortController();
  let cancelled = false;
  const abort = () => { cancelled = true; controller.abort(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const checkCancel = () => { if (existsSync(join(directory, 'cancel'))) abort(); };
  checkCancel();
  const cancelTimer = setInterval(checkCancel, 200);
  const heartbeat = () => {
    writeFileSync(join(directory, 'heartbeat.json.tmp'), JSON.stringify({ pid: process.pid, time: Date.now() }), { mode: 0o600 });
    renameSync(join(directory, 'heartbeat.json.tmp'), join(directory, 'heartbeat.json'));
  };
  heartbeat();
  const heartbeatTimer = setInterval(heartbeat, 1000);
  const signal = controller.signal;
  const storage = new AsyncLocalStorage<string>();
  const pending = new Set<Promise<unknown>>();
  let sequence = 0, eventSequence = 0, finished = false;
  const record: RunRecord = { schemaVersion: 1, id, status: "running", agent: config.agent, rows, outputs: [], workflow: options.workflowName, createdAt: options.createdAt ?? new Date().toISOString() };
  const save = () => {
    writeFileSync(join(directory, "run.json.tmp"), JSON.stringify(record, null, 2), { mode: 0o600 });
    renameSync(join(directory, "run.json.tmp"), join(directory, "run.json"));
  };
  const emit = (type: string, data: unknown) => {
    const event: RunEvent = { schemaVersion: 1, sequence: ++eventSequence, time: new Date().toISOString(), type, runId: id, data };
    appendFileSync(join(directory, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
    options.event?.(event);
  };
  const makeContext = (project: string): Context => {
  const callAgent = async (prompt: string, settings: AgentOptions = { prompt }): Promise<AgentResult> => {
    if (settings.readCommands && (!settings.readOnly || !settings.readCommands.length || settings.readCommands.some(command => typeof command !== "string" || !command.trim()))) throw new Error("readCommands requires readOnly and nonempty trusted commands");
    const harness = config.agents[settings.agent ?? config.agent];
    if (!harness) throw new Error("Unknown agent selection");
    if (harness.provider === "codex" || harness.provider === "claude") {
      const log = join(directory, `${++sequence}.agent.jsonl`);
      emit('agent.started', { stepId: storage.getStore(), provider: harness.provider, log });
      const timer = AbortSignal.timeout(settings.timeoutMs ?? config.timeoutMs);
      const result = await runSDK(harness.provider, { prompt, cwd: project, model: harness.model, executable: harness.executable,
        readOnly: settings.readOnly, readCommands: settings.readCommands, schema: settings.schema ? z.toJSONSchema(settings.schema, { target: "draft-7" }) : undefined,
        signal: AbortSignal.any([signal, timer]), event: event => appendFileSync(log, JSON.stringify(event) + "\n", { mode: 0o600 }) });
      emit("agent.finished", { stepId: storage.getStore(), provider: harness.provider, sessionId: result.sessionId, usage: result.usage, commands: result.commands, log });
      return { ...result, data: settings.schema ? settings.schema.parse(result.data) : undefined };
    }
    if (settings.readOnly) throw new Error("Command harness cannot enforce read-only mode; configure an SDK agent for review");
    if (settings.agent && settings.agent !== config.agent) throw new Error("Per-step command override is not supported");
    if (settings.schema) return { text: "", data: await context.agentJson(prompt, settings.schema) };
    const prepared = harnessInput(harness, prompt);
    const result = await context.exec(prepared.command, { input: prepared.input });
    return { text: result.stdout };
  };
  const agent = ((name: string, settings?: AgentOptions) => {
    if (settings) return context.step(name, () => callAgent(settings.prompt, settings));
    const harness = config.agents[config.agent];
    if (harness.provider !== "codex" && harness.provider !== "claude") {
      const prepared = harnessInput(harness, name);
      return context.exec(prepared.command, { input: prepared.input });
    }
    return callAgent(name).then(result => ({ exitCode: 0, stdout: result.text, stderr: "", log: directory }));
  }) as AgentCall;
  const context: Context = {
    task: options.task ?? "", input: options.input ?? {}, project, config, signal, agent,
    at: makeContext,
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
      const result = await execute(command, project, log, signal, config.timeoutMs, args.input);
      emit("command.finished", { stepId: storage.getStore(), exitCode: result.exitCode, log });
      if (result.exitCode !== 0 && !args.allowFailure) throw new Error(`Command failed (${result.exitCode}): ${command[0]}. Log: ${result.log}`);
      return result;
    },
    async agentJson(prompt, schema) {
      const harness = config.agents[config.agent];
      if (harness.provider === "codex" || harness.provider === "claude") return (await callAgent(prompt, { prompt, schema })).data as z.output<typeof schema>;
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
    output(name, value, options = {}) {
      if (finished) throw new Error("Run already finished");
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      if (text === undefined) throw new Error("Output must be text or JSON-serializable data");
      const outputId = `output-${record.outputs.length + 1}`;
      const format = typeof value === "string" ? "text" : "json";
      const path = join(directory, `${outputId}.${format === "text" ? "txt" : "json"}`);
      writeFileSync(path, text, { mode: 0o600 });
      const output: Output = { id: outputId, stepId: storage.getStore(), name, format, path, value: format === "text" ? text : JSON.parse(text), ...(options.detail ? { detail: true } : {}) };
      record.outputs.push(output); save(); emit("output.created", output);
      return output;
    },
  };
  return context;
  };
  const context = makeContext(options.project);
  try {
    save(); emit("run.started", { agent: config.agent });
    if (signal.aborted) throw new Error('Cancelled before execution');
    await workflow(context);
    if (pending.size) throw new Error("Workflow returned with unfinished steps; await all steps");
    if (signal.aborted) throw new Error("Cancelled");
    record.status = "completed";
  } catch (error) {
    // Source workflows and the compiled CLI can load separate copies of this module.
    record.status = cancelled ? (options.interrupted?.() ? "interrupted" : "cancelled") :
      error instanceof Error && Reflect.get(error, blockedTag) === true ? "blocked" : "failed";
    if (record.status === 'interrupted') record.cleanup = 'Workflow cleanup was allowed to run; inspect outputs for warnings.';
    record.error = error instanceof Error ? error.message : String(error);
    if (record.status === 'interrupted') record.error = 'Worker connection lost; no automatic retry. ' + record.error;
    controller.abort();
    await Promise.allSettled([...pending]);
  } finally {
    finished = true; options.signal?.removeEventListener("abort", abort);
    clearInterval(cancelTimer); clearInterval(heartbeatTimer);
    save(); emit("run.finished", record);
  }
  if (record.status !== "completed") throw new RunError(record.error ?? "Run failed", directory, record);
  return directory;
}
