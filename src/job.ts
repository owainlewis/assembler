import { join } from 'node:path';
import { runWorkflow, RunError } from './index.js';
import { atomicJSON, exists, readJSON, readRun, runDirectory } from './runs.js';
import type { Request } from './queue.js';
import { loadWorkflow } from './workflows.js';

const [project, id] = process.argv.slice(2);
const dir = runDirectory(project, id);
const controller = new AbortController();
let disconnected = false;
let executionFinished = false;
const abort = () => controller.abort();
process.on('SIGTERM', abort); process.on('SIGINT', abort);
process.on('disconnect', () => {
  // Late IPC loss must not reclassify a finished result or a user cancellation.
  if (!executionFinished && !controller.signal.aborted) { disconnected = true; abort(); }
});
try {
  // Record ownership before a workflow's potentially slow top-level import.
  await atomicJSON(join(dir, 'heartbeat.json'), { pid: process.pid, time: Date.now() });
  const request = await readJSON<Request>(join(dir, 'request.json'));
  if (controller.signal.aborted || await exists(join(dir, 'cancel'))) {
    const record = await readRun(project, id);
    await atomicJSON(join(dir, 'run.json'), { ...record, status: disconnected ? 'interrupted' : 'cancelled', cleanup: 'Not started' });
  } else {
    const workflow = await loadWorkflow(request.entry);
    try {
      await runWorkflow(workflow, { project, id, workflowName: request.name, createdAt: request.createdAt,
        config: request.config, input: request.input, task: request.task, signal: controller.signal,
        interrupted: () => disconnected });
    } finally { executionFinished = true; }
  }
} catch (error) {
  if (!(error instanceof RunError)) {
    const record = await readRun(project, id);
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = controller.signal.aborted || await exists(join(dir, 'cancel'));
    await atomicJSON(join(dir, 'run.json'), { ...record, status: disconnected ? 'interrupted' : cancelled ? 'cancelled' : 'failed',
      error: disconnected ? 'Worker connection lost during loading; no automatic retry. ' + message : message,
      ...(cancelled ? { cleanup: 'Unknown: module initialization may have created resources. Inspect before rerunning.' } : {}) });
  }
} finally {
  executionFinished = true;
  // runWorkflow owns finalization. Never rewrite a published terminal outcome.
  process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
  if (process.connected) process.disconnect();
}
