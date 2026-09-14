#!/usr/bin/env node
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs, format } from "node:util";
import { tsImport } from "tsx/esm/api";
import { defaults, runWorkflow, RunError, type Config, type RunRecord } from "./index.js";
import { progress, formatOutputs, plain } from "./display.js";
import build from "./build.js";
import fixChecks from "./fix-checks.js";
import reviewPR from "./review-pr.js";
import fetchTask from "./fetch-task.js";

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    task: { type: "string" }, prompt: { type: "string" }, project: { type: "string", default: "." },
    agent: { type: "string" }, json: { type: "boolean" }, events: { type: "boolean" }, help: { type: "boolean", short: "h" },
    input: { type: "string" }, "input-file": { type: "string" }, ticket: { type: "string" },
  } });
  if (values.json && values.events) throw new Error("Choose --json or --events");
  const [command, requestedName = "build"] = positionals;
  const name = command === "build" ? "build" : requestedName;
  if (values.help || !command) {
    console.log("Assembler · coding workflows as code\n\nassembler init [--project .]\nassembler build --ticket ENG-123 --input-file delivery.json\nassembler run fix-checks --input '{\"checks\":[[\"npm\",\"test\"]]}'\nassembler run review-pr --input '{\"pr\":123}'\nassembler run workflow.ts --input-file inputs.json [--agent codex]\n\n--prompt: workflow-specific instructions\n--json: final record; --events: NDJSON progress\nConfig: assembler.json (agents/runtime); workflow inputs own all delivery policy.");
    return;
  }
  const project = await realpath(resolve(values.project!));
  if (command === "init") {
    await writeFile(join(project, "assembler.json"), JSON.stringify(defaults, null, 2) + "\n", { flag: "wx" });
    await mkdir(join(project, ".assembler", "workflows"), { recursive: true });
    console.log("Created assembler.json. Supply workflow inputs with --input or --input-file.");
    return;
  }
  if (command !== "run" && command !== "build") throw new Error(`Unknown command: ${command}`);
  if (values.input && values["input-file"]) throw new Error("Choose --input or --input-file");
  let input: Record<string, unknown> = values.input ? JSON.parse(values.input) : values["input-file"] ? JSON.parse(await readFile(resolve(project, values["input-file"]), "utf8")) : {};
  if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("Workflow input must be an object");
  // A project's optional workflow defaults belong to that workflow, not Config.
  let custom: Partial<Config> & { workflows?: Record<string, Record<string, unknown>> } = {};
  try { custom = JSON.parse(await readFile(join(project, "assembler.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  input = { ...custom.workflows?.[name], ...input, ...(values.prompt ? { prompt: values.prompt } : {}), ...(values.ticket ? { ticket: values.ticket } : {}) };
  if (command === "build" && values.task) input.ticket = values.task;
  const task = command === "build" ? String(input.ticket ?? "") : values.task ? await readFile(resolve(project, values.task), "utf8") : values.prompt ?? "";
  const { workflows, ...runtime } = custom;
  const config: Config = { ...defaults, ...runtime, agents: { ...defaults.agents, ...runtime.agents }, agent: values.agent ?? runtime.agent ?? defaults.agent };
  const machine = values.json || values.events;
  const ui = progress(!machine);
  // Keep accidental workflow console messages out of the stdout protocol.
  const original = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error };
  for (const method of ["log", "info", "debug", "warn", "error"] as const) console[method] = (...args: unknown[]) => ui.message(format(...args));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  let run: string | undefined, record: RunRecord | undefined;
  try {
    const builtins: Record<string, unknown> = { build, "task-to-pr": build, "fetch-task": fetchTask, "fix-checks": fixChecks, "review-pr": reviewPR };
    const loaded = builtins[name] ?? (await tsImport(
      name.endsWith(".ts") || name.endsWith(".js") ? resolve(project, name) : join(project, ".assembler", "workflows", `${name}.ts`), import.meta.url)).default;
    const workflow = typeof loaded === "function" ? loaded : loaded?.default;
    if (typeof workflow !== "function") throw new Error("Workflow must default-export a function");
    if (!machine) process.stderr.write(`\nassembler · ${plain(name)} · ${plain(String(input.ticket ?? values.task ?? "task"))}\n\n`);
    try {
      run = await runWorkflow(workflow, { task, input, project, config, signal: controller.signal,
        update: ui.update, event: values.events ? event => process.stdout.write(JSON.stringify(event) + "\n") : undefined });
      record = JSON.parse(await readFile(join(run, "run.json"), "utf8"));
    } catch (error) {
      if (!(error instanceof RunError)) throw error;
      run = error.run; record = error.record; process.exitCode = record.status === "cancelled" ? 130 : 1;
    }
  } finally {
    ui.finish(); Object.assign(console, original);
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  }
  if (values.json) process.stdout.write(JSON.stringify({ ...record, run }) + "\n");
  else if (!values.events && record) {
    process.stdout.write(formatOutputs(record));
    if (record.error) process.stderr.write(`\n${plain(record.error)}\n`);
    process.stdout.write(`\n${record.status === "completed" ? "Completed" : record.status} · ${run}\n`);
  }
}
main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  const args = process.argv.slice(2);
  if (args.includes("--json")) process.stdout.write(JSON.stringify({ schemaVersion: 1, status: "failed", error: message, run: null, rows: [], outputs: [] }) + "\n");
  else if (args.includes("--events")) process.stdout.write(JSON.stringify({ schemaVersion: 1, sequence: 1, time: new Date().toISOString(), type: "run.rejected", runId: null, data: { error: message } }) + "\n");
  else process.stderr.write(plain(message) + "\n");
  process.exitCode = 1;
});
