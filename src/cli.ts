#!/usr/bin/env node
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { tsImport } from "tsx/esm/api";
import { defaults, runWorkflow, type Row, type Config } from "./index.js";
import build from "./build.js";

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    task: { type: "string" }, prompt: { type: "string" }, project: { type: "string", default: "." },
    agent: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  const [command, name = "build"] = positionals;
  if (values.help || !command) {
    console.log("Assembler · coding workflows as code\n\nassembler init [--project .]\nassembler run [build|workflow.ts] --task task.md [--agent codex]\nassembler run build --prompt 'Fix the parser' [--json]\n\nLocal workflows: .assembler/workflows/<name>.ts\nConfig: assembler.json · Node 22+ · Ctrl+C cancels child processes");
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
  const loaded = name === "build" ? build : (await tsImport(
    name.endsWith(".ts") || name.endsWith(".js") ? resolve(project, name) : join(project, ".assembler", "workflows", `${name}.ts`), import.meta.url)).default;
  // tsx exposes a CommonJS namespace for projects without type: module.
  const workflow = typeof loaded === "function" ? loaded : loaded?.default;
  if (typeof workflow !== "function") throw new Error("Workflow must default-export a function");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  const tty = process.stderr.isTTY && !values.json;
  let rendered = 0;
  const safe = (value: string) => stripVTControlCharacters(value).replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 100);
  const display = (rows: Row[]) => {
    if (values.json) return;
    if (tty && rendered) process.stderr.write(`\x1b[${rendered}A\x1b[J`);
    const lines = rows.map(row => {
      const icon = row.status === "passed" ? "✓" : row.status === "failed" ? "✗" : "↻";
      const seconds = Math.floor((row.durationMs ?? Date.now() - row.started) / 1000);
      const duration = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
      const color = row.status === "passed" ? "\x1b[32m" : row.status === "failed" ? "\x1b[31m" : "\x1b[36m";
      return `${tty ? color : ""}${icon}${tty ? "\x1b[0m" : ""} ${safe(row.name).padEnd(24)} ${duration}`;
    });
    if (tty) { process.stderr.write(lines.join("\n") + "\n"); rendered = lines.length; }
    else if (lines.length) process.stderr.write(lines.at(-1) + "\n");
  };
  let current: Row[] = [];
  if (!values.json) process.stderr.write(`\nassembler · ${safe(name)} · ${safe(values.task ?? "task")}\n\n`);
  const interval = tty ? setInterval(() => display(current), 1000) : undefined;
  try {
    const run = await runWorkflow(workflow, { task, project, config, signal: controller.signal, update: rows => { current = rows; display(rows); } });
    console.log(values.json ? JSON.stringify({ status: "completed", run }) : `\nCompleted · ${run}`);
  } finally {
    if (interval) clearInterval(interval);
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  }
}
main().catch(error => { console.error(String(error)); process.exitCode = 1; });
