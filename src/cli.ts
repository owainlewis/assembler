#!/usr/bin/env node
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { parseArgs, format } from "node:util";
import { defaults, runWorkflow, RunError, validateConfig, type Config, type RunRecord } from "./index.js";
import { progress, formatOutputs, plain } from "./display.js";
import { loadWorkflow, resolveWorkflow } from './workflows.js';
import { enqueue, startWorker, staleRun, workerRoot } from './queue.js';
import { cancelRun, formatRun, listRuns, readRun, streamLogs, readJSON } from './runs.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    task: { type: "string" }, prompt: { type: "string" }, project: { type: "string", default: "." },
    agent: { type: "string" }, json: { type: "boolean" }, events: { type: "boolean" }, verbose: { type: "boolean" }, help: { type: "boolean", short: "h" },
    input: { type: "string" }, "input-file": { type: "string" }, ticket: { type: "string" },
    detach: { type: 'boolean' }, follow: { type: 'boolean' }, step: { type: 'string' }, concurrency: { type: 'string' },
  } });
  if (values.json && values.events) throw new Error("Choose --json or --events");
  const [command, requestedName = "build"] = positionals;
  const name = command === "build" ? "build" : requestedName;
  if (values.help || !command) {
    console.log('Assembler · coding workflows as code\n\nassembler run workflow.ts --prompt "Your task" [--detach]\nassembler runs list\nassembler runs show <id>\nassembler runs logs <id> [--follow] [--step "Step name"]\nassembler runs cancel <id>\nassembler worker start [--concurrency 2]\nassembler worker status\nassembler worker stop\nassembler init [--project .]\nassembler build --ticket ENG-123\n\n--project: project directory; --agent: selected harness\n--input / --input-file: workflow inputs; --json: machine-readable output\n--events: foreground NDJSON progress; --detach: queue on the local Linux worker');
    return;
  }
  const project = await realpath(resolve(values.project!));
  // Loaders such as esbuild inherit cwd. A sudo caller may still be in /root,
  // which is inaccessible to the selected user even with an absolute --project.
  process.chdir(project);
  if (command === 'runs') {
    const action = positionals[1], id = positionals[2];
    if (action === 'list') {
      for (const record of await listRuns(project)) await staleRun(project, record);
      const records = await listRuns(project);
      console.log(values.json ? JSON.stringify(records) : records.map(record => `${record.id}  ${record.status.padEnd(12)} ${plain(record.workflow ?? 'workflow')}`).join('\n') || 'No runs yet.');
    } else {
      if (!id) throw new Error('Supply a run ID');
      await staleRun(project, await readRun(project, id));
      if (action === 'show') console.log(values.json ? JSON.stringify(await readRun(project, id)) : formatRun(await readRun(project, id)));
      else if (action === 'cancel') {
        const status = await cancelRun(project, id);
        console.log(values.json ? JSON.stringify({ id, status }) : `${id}: ${status}`);
      } else if (action === 'logs') {
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.on('SIGINT', stop);
        try { await streamLogs(project, id, { follow: values.follow, step: values.step, json: values.json, signal: controller.signal }); }
        finally { process.removeListener('SIGINT', stop); }
      } else throw new Error('Use runs list, show, logs, or cancel');
    }
    return;
  }
  if (command === 'worker') {
    const root = workerRoot(project);
    if (positionals[1] === 'start') {
      await startWorker(project, values.concurrency === undefined ? undefined : Number(values.concurrency));
      const status = await readJSON(join(root, 'worker.json'));
      console.log(values.json ? JSON.stringify(status) : 'Worker started. Use assembler worker status to inspect it.');
    } else if (positionals[1] === 'stop') {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'worker.stop'), '', { mode: 0o600 });
      console.log(values.json ? JSON.stringify({ status: 'stop requested' }) : 'Worker will stop after active runs finish; queued runs remain queued.');
    } else if (positionals[1] === 'status') {
      let status: { status: string; pid?: number; time?: number } = { status: 'stopped' };
      try {
        status = await readJSON(join(root, 'worker.json'));
        if (status.status === 'stopped') { /* terminal worker record */ }
        else if (Date.now() - (status.time ?? 0) > 5000) status.status = 'unavailable';
        else if (status.pid) process.kill(status.pid, 0);
      } catch { status.status = 'stopped'; }
      console.log(values.json ? JSON.stringify(status) : JSON.stringify(status, null, 2));
    } else throw new Error('Use worker start, status, or stop');
    return;
  }
  if (command === "init") {
    await writeFile(join(project, "assembler.json"), JSON.stringify(defaults, null, 2) + "\n", { flag: "wx" });
    await mkdir(join(project, ".assembler", "workflows"), { recursive: true });
    console.log("Created assembler.json. Supply workflow inputs with --input or --input-file.");
    return;
  }
  if (command !== "run" && command !== "build") throw new Error(`Unknown command: ${command}`);
  if (values.input !== undefined && values["input-file"] !== undefined) throw new Error("Choose --input or --input-file");
  let input: Record<string, unknown> = values.input !== undefined ? JSON.parse(values.input) : values["input-file"] !== undefined ? JSON.parse(await readFile(resolve(project, values["input-file"]), "utf8")) : {};
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
  validateConfig(config);
  if (values.detach) {
    if (values.events) throw new Error('Use --json, not --events, when submitting a detached run');
    const record = await enqueue(project, name, input, task, config);
    let warning: string | undefined;
    try { await startWorker(project); } catch (error) { warning = String(error); }
    console.log(values.json ? JSON.stringify({ id: record.id, status: 'queued', warning }) : `Queued ${record.id}\nassembler runs show ${record.id}${warning ? `\n${warning}` : ''}`);
    return;
  }
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
    const workflow = await loadWorkflow(resolveWorkflow(project, name).path);
    if (!machine) process.stderr.write(`\nassembler · ${plain(name)} · ${plain(String(input.ticket ?? values.task ?? basename(project)))}\n\n`);
    try {
      run = await runWorkflow(workflow, { task, input, project, config, workflowName: name, signal: controller.signal,
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
    // Keep the human summary on one stream so its reason precedes cleanup/results.
    if (record.error) process.stdout.write(`\n${plain(record.error)}\n`);
    process.stdout.write(formatOutputs(record, values.verbose));
    const label = record.status === "completed" ? "Completed" : record.status === "blocked" ? "Blocked" : record.status;
    process.stdout.write(`\n${label} · ${record.id}\nDetails: assembler runs show ${record.id}\nLogs: assembler runs logs ${record.id} --follow\n`);
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
