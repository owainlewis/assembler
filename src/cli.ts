#!/usr/bin/env node
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs, format } from "node:util";
import { tsImport } from "tsx/esm/api";
import { defaults, runWorkflow, RunError, type Config, type RunRecord } from "./index.js";
import { progress, formatOutputs, plain } from "./display.js";
import build from "./build.js";

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    task: { type: "string" }, prompt: { type: "string" }, project: { type: "string", default: "." },
    agent: { type: "string" }, json: { type: "boolean" }, events: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.json && values.events) throw new Error("Choose --json or --events");
  const [command, name = "build"] = positionals;
  if (values.help || !command) {
    console.log("Assembler · coding workflows as code\n\nassembler init [--project .]\nassembler run [build|workflow.ts] --task task.md [--agent codex]\nassembler run build --prompt 'Fix the parser' [--json | --events]\n\n--json: one final result, including failures and named outputs\n--events: versioned NDJSON events while the run proceeds\nLocal workflows: .assembler/workflows/<name>.ts\nConfig: assembler.json · Node 22+ · Ctrl+C cancels child processes");
    return;
  }
  const project = await realpath(resolve(values.project!));
  if (command === "init") {
    await writeFile(join(project, "assembler.json"), JSON.stringify(defaults, null, 2) + "\n", { flag: "wx" });
    await mkdir(join(project, ".assembler", "workflows"), { recursive: true });
    console.log("Created assembler.json. Add validation commands to checks, then run a task.");
    return;
  }
  if (command !== "run") throw new Error(`Unknown command: ${command}`);
  if (!!values.task === !!values.prompt) throw new Error("Supply exactly one of --task FILE or --prompt TEXT");
  const task = values.task ? await readFile(resolve(project, values.task), "utf8") : values.prompt!;
  if (!task.trim()) throw new Error("Task cannot be empty");
  let custom: Partial<Config> = {};
  try { custom = JSON.parse(await readFile(join(project, "assembler.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const config: Config = { ...defaults, ...custom, agents: { ...defaults.agents, ...custom.agents }, agent: values.agent ?? custom.agent ?? defaults.agent };
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
    const loaded = name === "build" ? build : (await tsImport(
      name.endsWith(".ts") || name.endsWith(".js") ? resolve(project, name) : join(project, ".assembler", "workflows", `${name}.ts`), import.meta.url)).default;
    const workflow = typeof loaded === "function" ? loaded : loaded?.default;
    if (typeof workflow !== "function") throw new Error("Workflow must default-export a function");
    if (!machine) process.stderr.write(`\nassembler · ${plain(name)} · ${plain(values.task ?? "task")}\n\n`);
    try {
      run = await runWorkflow(workflow, { task, project, config, signal: controller.signal,
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
