import { join } from 'node:path';
import { runWorkflow, RunError } from './index.js';
import { atomicJSON, readJSON, readRun, runDirectory } from './runs.js';
import type { Request } from './queue.js';
import { loadWorkflow } from './workflows.js';

const [project, id] = process.argv.slice(2);
const dir = runDirectory(project, id);
const controller = new AbortController();
let disconnected = false;
const abort = () => controller.abort();
process.on('SIGTERM', abort); process.on('SIGINT', abort);
process.on('disconnect', () => { disconnected = true; abort(); });
try {
  const request = await readJSON<Request>(join(dir, 'request.json'));
  const workflow = await loadWorkflow(request.entry);
  await runWorkflow(workflow, { project, id, workflowName: request.name, createdAt: request.createdAt,
    config: request.config, input: request.input, task: request.task, signal: controller.signal });
} catch (error) {
  if (!(error instanceof RunError)) {
    const record = await readRun(project, id);
    await atomicJSON(join(dir, 'run.json'), { ...record, status: 'failed', error: error instanceof Error ? error.message : String(error) });
  }
} finally {
  if (disconnected) {
    const record = await readRun(project, id);
    await atomicJSON(join(dir, 'run.json'), { ...record, status: 'interrupted', error: 'Worker connection lost; execution cancelled. No automatic retry.', cleanup: 'Workflow cleanup was allowed to run; inspect outputs for warnings.' });
  }
  process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
  if (process.connected) process.disconnect();
}
