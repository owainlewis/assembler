import { fork, type ChildProcess } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJSON, claimRun, exists, listRuns, readJSON, readRun, runDirectory, terminal } from './runs.js';
import { sibling, staleRun, workerRoot } from './queue.js';

const project = process.argv[2];
const root = workerRoot(project);
let shutdown = false;
process.on('SIGTERM', () => { shutdown = true; });
process.on('SIGINT', () => { shutdown = true; });
const active = new Map<string, { child: ChildProcess; cancelAt?: number }>();

async function tick() {
  let concurrency = 1;
  if (await exists(join(root, 'worker-settings.json'))) concurrency = (await readJSON<{ concurrency: number }>(join(root, 'worker-settings.json'))).concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid worker concurrency');
  const stopping = shutdown || await exists(join(root, 'worker.stop'));
  await atomicJSON(join(root, 'worker.json'), { pid: process.pid, time: Date.now(), concurrency, status: stopping ? 'stopping' : 'running' });
  let records = await listRuns(project);
  for (const record of records) {
    if (!active.has(record.id)) await staleRun(project, record);
    const job = active.get(record.id);
    if (job && (shutdown || await exists(join(runDirectory(project, record.id), 'cancel')))) {
      if (!job.cancelAt) { job.cancelAt = Date.now(); job.child.kill('SIGTERM'); }
      if (Date.now() - job.cancelAt > 30_000) job.child.kill('SIGKILL');
    }
  }
  records = await listRuns(project);
  const running = records.filter(record => record.status === 'running').length;
  let slots = Math.max(0, concurrency - Math.max(running, active.size));
  for (const record of records.reverse()) {
    if (record.status !== 'queued') continue;
    const dir = runDirectory(project, record.id);
    const cancelled = await exists(join(dir, 'cancel'));
    if (!cancelled && (stopping || !slots)) continue;
    const claim = await claimRun(project, record.id, cancelled ? 'cancelled' : 'running');
    if (claim.status === 'cancelled') {
      await atomicJSON(join(dir, 'run.json'), { ...record, status: 'cancelled', cleanup: 'Not started' });
      continue;
    }
    if (!claim.won) {
      // A previous worker died after claiming but before publishing execution.
      await atomicJSON(join(dir, 'run.json'), { ...record, status: 'interrupted', error: 'Dispatch was interrupted. No automatic retry.', cleanup: 'Unknown: inspect workflow resources.' });
      continue;
    }
    slots--;
    await atomicJSON(join(dir, 'run.json'), { ...record, status: 'running' });
    const log = await open(join(dir, 'console.log'), 'a', 0o600);
    let child: ChildProcess;
    try { child = fork(sibling('job'), [project, record.id], { cwd: project, stdio: ['ignore', log.fd, log.fd, 'ipc'] }); }
    catch (error) { await log.close(); throw error; }
    active.set(record.id, { child });
    let finished = false;
    const finish = async (error?: Error) => {
      if (finished) return;
      finished = true;
      try {
        const latest = await readRun(project, record.id);
        if (!terminal(latest.status)) await atomicJSON(join(dir, 'run.json'), { ...latest, status: 'interrupted', error: error?.message ?? 'Execution exited without a final result', cleanup: 'Unknown: inspect workflow resources.' });
      } finally { active.delete(record.id); }
    };
    child.once('error', error => { void finish(error).catch(console.error); });
    child.once('exit', () => { void finish().catch(console.error); });
    await log.close();
  }
  return !(stopping && active.size === 0);
}

try { while (await tick()) await delay(250); }
catch (error) { console.error(error); process.exitCode = 1; }
finally {
  // IPC loss instructs execution children to cancel and execute their finally blocks.
  for (const { child } of active.values()) if (child.connected) child.disconnect();
  await atomicJSON(join(root, 'worker.json'), { pid: process.pid, time: 0, status: 'stopped' });
}
