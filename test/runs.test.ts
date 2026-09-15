import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { defaults, runWorkflow } from '../src/index.js';
import { atomicJSON, claimRun, cancelRun, listRuns, readRun, runDirectory, streamLogs, terminal, readJSON } from '../src/runs.js';
import { enqueue, startWorker } from '../src/queue.js';

const linux = process.platform === 'linux';

for (const reason of ['disconnect', 'cancel'] as const) test(reason + ' during a failing module import retains the lifecycle outcome', { skip: !linux, timeout: 30_000 }, async () => {
  const project = await mkdtemp(join(tmpdir(), 'assembler-import-disconnect-'));
  try {
    await writeFile(join(project, 'package.json'), '{"type":"module"}');
    await writeFile(join(project, 'flow.ts'), `import { writeFileSync } from 'node:fs';
      writeFileSync(new URL('./loading', import.meta.url), '');
      await new Promise(resolve => setTimeout(resolve, 1500));
      throw new Error('module initialization failed');
      export default async () => {};`);
    const job = await enqueue(project, 'flow.ts', {}, '', defaults);
    await startWorker(project);
    await until(async () => { try { await access(join(runDirectory(project, job.id), 'source', 'loading')); return true; } catch { return false; } });
    const worker = await readJSON<{ pid: number }>(join(project, '.assembler', 'worker.json'));
    if (reason === 'disconnect') process.kill(worker.pid, 'SIGKILL');
    else await cancelRun(project, job.id);
    const result = await until(async () => { const r = await readRun(project, job.id); return terminal(r.status) && r; });
    assert.equal(result.status, reason === 'disconnect' ? 'interrupted' : 'cancelled');
    assert.match(result.error!, /module initialization failed/);
    if (reason === 'disconnect') assert.match(result.error!, /Worker connection lost/);
    assert.match(result.cleanup!, /Unknown/);
    if (reason === 'disconnect') await startWorker(project);
  } finally { await stop(project); await rm(project, { recursive: true, force: true }); }
});

test('late disconnect cannot overwrite completed, failed or cancelled outcomes', async () => {
  const project = await mkdtemp(join(tmpdir(), 'assembler-late-disconnect-'));
  try {
    for (const expected of ['completed', 'failed', 'cancelled']) {
      const controller = new AbortController();
      let disconnected = false;
      let id = '';
      const workflow = async () => {
        if (expected === 'cancelled') controller.abort();
        if (expected === 'failed') throw new Error('original failure');
      };
      await runWorkflow(workflow, { project, config: defaults, signal: controller.signal,
        interrupted: () => disconnected,
        event: event => {
          if (event.type === 'run.finished') { id = event.runId; disconnected = true; controller.abort(); }
        },
      }).catch(() => {});
      const record = await readRun(project, id);
      assert.equal(record.status, expected);
      if (expected === 'failed') assert.equal(record.error, 'original failure');
    }
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('queued cancellation and dispatch atomically choose one winner', { skip: !linux, timeout: 30_000 }, async () => {
  const project = await mkdtemp(join(tmpdir(), 'assembler-claim-race-'));
  try {
    await writeFile(join(project, 'flow.ts'), `import { writeFileSync } from 'node:fs';
      writeFileSync(new URL('./imported', import.meta.url), 'side effect');
      export default async () => {};`);
    const jobs = await Promise.all(Array.from({ length: 20 }, () => enqueue(project, 'flow.ts', {}, '', defaults)));
    for (const job of jobs) {
      const [cancelled, claim] = await Promise.all([cancelRun(project, job.id), claimRun(project, job.id, 'running')]);
      if (cancelled === 'cancelled') assert.equal(claim.status, 'cancelled');
      else { assert.equal(cancelled, 'cancellation requested'); assert.equal(claim.status, 'running'); }
    }
    await startWorker(project);
    await until(async () => (await listRuns(project)).every(record => terminal(record.status)));
    for (const job of jobs) {
      await assert.rejects(access(join(runDirectory(project, job.id), 'source', 'imported')));
    }
  } finally { await stop(project); await rm(project, { recursive: true, force: true }); }
});

test('log following reconciles a dead execution and preserves split UTF-8', async () => {
  const project = await mkdtemp(join(tmpdir(), 'assembler-dead-log-'));
  try {
    const dir = await runWorkflow(async () => {}, { project, config: defaults });
    const [record] = await listRuns(project);
    await atomicJSON(join(dir, 'run.json'), { ...record, status: 'running' });
    await atomicJSON(join(dir, 'heartbeat.json'), { pid: 2147483647, time: 0 });
    const message = 'a'.repeat(65535) + '🌍';
    await writeFile(join(dir, 'console.log'), message);
    let text = '';
    await streamLogs(project, record.id, { follow: true, json: true }, value => { text += JSON.parse(value).text; });
    assert.equal(text, message);
    assert.equal((await readRun(project, record.id)).status, 'interrupted');
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('running detached cancellation executes finally and releases the slot', { skip: !linux, timeout: 30_000 }, async () => {
  const project = await mkdtemp(join(tmpdir(), 'assembler-job-cancel-'));
  try {
    await writeFile(join(project, 'flow.ts'), `export default async ctx => {
      try { await ctx.step('Wait', () => ctx.exec([process.execPath, '-e', 'setInterval(()=>{},1000)'])); }
      finally { ctx.output('cleanup', 'ran'); }
    }`);
    const job = await enqueue(project, 'flow.ts', {}, '', defaults);
    await startWorker(project);
    await until(async () => (await readRun(project, job.id)).rows.length > 0);
    await cancelRun(project, job.id);
    const result = await until(async () => { const r = await readRun(project, job.id); return terminal(r.status) && r; });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.outputs[0].value, 'ran');
  } finally { await stop(project); await rm(project, { recursive: true, force: true }); }
});
async function until<T>(fn: () => Promise<T | undefined | false>, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error('Timed out waiting for test condition');
}
async function stop(project: string) {
  await writeFile(join(project, '.assembler', 'worker.stop'), '');
  await until(async () => {
    try { return (await readJSON<{ status: string }>(join(project, '.assembler', 'worker.json'))).status === 'stopped'; }
    catch { return false; }
  });
}

test('run history, step logs, outputs and invalid IDs', async () => {
  const project = await mkdtemp(join(tmpdir(), 'assembler-history-'));
  try {
    const path = await runWorkflow(async ctx => {
      await ctx.step('First', () => ctx.exec([process.execPath, '-e', 'console.log("first output")']));
      await ctx.step('Second', () => ctx.exec([process.execPath, '-e', 'console.log("second output")']));
      ctx.output('Result', 'done');
    }, { project, config: defaults, workflowName: 'demo' });
    const [record] = await listRuns(project);
    assert.equal(record.workflow, 'demo'); assert.equal(record.status, 'completed');
    assert.equal(record.outputs[0].value, 'done');
    const damaged = runDirectory(project, 'damaged');
    await mkdir(damaged);
    await writeFile(join(damaged, 'run.json'), '{}');
    assert.equal((await listRuns(project)).length, 1);
    let text = '';
    await streamLogs(project, record.id, { step: 'Second' }, value => { text += value; });
    assert.match(text, /second output/); assert.doesNotMatch(text, /first output/);
    await assert.rejects(streamLogs(project, record.id, { step: 'absent' }), /No step/);
    assert.throws(() => runDirectory(project, '../escape'), /Invalid/);
    await assert.rejects(readRun(project, '../escape'));
    await writeFile(join(path, 'events.jsonl'), JSON.stringify({ data: { log: '/etc/passwd' } }) + '\n');
    await assert.rejects(streamLogs(project, record.id, {}), /escapes/);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('foreground cancellation runs cleanup and log follow terminates', async () => {
  const project = await mkdtemp(join(tmpdir(), 'assembler-cancel-'));
  let cleaned = false;
  try {
    const running = runWorkflow(async ctx => {
      try { await ctx.step('Wait', () => ctx.exec([process.execPath, '-e', 'console.log("started");setInterval(()=>{},1000)'])); }
      finally { cleaned = true; }
    }, { project, config: defaults });
    const caught = running.catch(error => error);
    const record = await until(async () => (await listRuns(project))[0]);
    const logs = streamLogs(project, record.id, { follow: true }, () => {});
    await cancelRun(project, record.id);
    await caught; await logs;
    assert.equal(cleaned, true);
    assert.equal((await readRun(project, record.id)).status, 'cancelled');
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('ten queued runs use frozen inputs and workflow source with bounded concurrency', { skip: !linux, timeout: 60_000 }, async () => {
  const project = await mkdtemp(join(tmpdir(), 'assembler-queue-'));
  try {
    await writeFile(join(project, 'flow.ts'), `export default async ctx => {
      await ctx.step('Work', () => ctx.exec([process.execPath, '-e', 'setTimeout(()=>console.log("frozen"),400)']));
      ctx.output('input', ctx.input.value);
    }`);
    const jobs = await Promise.all(Array.from({ length: 10 }, (_, value) => enqueue(project, 'flow.ts', { value }, '', defaults)));
    await writeFile(join(project, 'flow.ts'), 'throw new Error("edited after submission");');
    await Promise.all([startWorker(project, 2), startWorker(project, 2), startWorker(project, 2)]);
    let maximum = 0;
    await until(async () => {
      const records = await listRuns(project);
      maximum = Math.max(maximum, records.filter(record => record.status === 'running').length);
      assert.ok(maximum <= 2, `Concurrency exceeded: ${maximum}`);
      return records.every(record => terminal(record.status)) && records;
    }, 40_000);
    for (const [index, job] of jobs.entries()) {
      const result = await readRun(project, job.id);
      assert.equal(result.status, 'completed', result.error);
      assert.equal(result.outputs[0].value, index);
    }
    assert.equal(maximum, 2);
  } finally { await stop(project); await rm(project, { recursive: true, force: true }); }
});

test('queued cancellation does not start the worker or execute code', { skip: !linux }, async () => {
  const project = await mkdtemp(join(tmpdir(), 'assembler-queued-cancel-'));
  try {
    await writeFile(join(project, 'flow.ts'), 'export default async () => { throw new Error("must not run"); };');
    const job = await enqueue(project, 'flow.ts', {}, '', defaults);
    assert.equal(await cancelRun(project, job.id), 'cancelled');
    assert.equal((await readRun(project, job.id)).status, 'cancelled');
    await assert.rejects(access(join(project, '.assembler', 'worker.json')));
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('worker death interrupts running job, allows cleanup and preserves queued work', { skip: !linux, timeout: 30_000 }, async () => {
  const project = await mkdtemp(join(tmpdir(), 'assembler-worker-death-'));
  try {
    await writeFile(join(project, 'flow.ts'), `export default async ctx => {
      try { await ctx.step('Wait', () => ctx.exec([process.execPath, '-e', 'setInterval(()=>{},1000)'])); }
      finally { ctx.output('cleanup', 'ran'); }
    }`);
    const first = await enqueue(project, 'flow.ts', {}, '', defaults);
    const second = await enqueue(project, 'flow.ts', {}, '', defaults);
    await startWorker(project, 1);
    await until(async () => (await readRun(project, first.id)).rows.length > 0);
    const worker = await readJSON<{ pid: number }>(join(project, '.assembler', 'worker.json'));
    process.kill(worker.pid, 'SIGKILL');
    const result = await until(async () => { const r = await readRun(project, first.id); return r.status === 'interrupted' && r; });
    assert.equal(result.outputs.find(output => output.name === 'cleanup')?.value, 'ran');
    assert.equal((await readRun(project, second.id)).status, 'queued');
    await cancelRun(project, second.id);
    await startWorker(project);
    await stop(project);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('snapshot rejects escaping workflows and excludes artifacts and secrets', { skip: !linux }, async () => {
  const project = await mkdtemp(join(tmpdir(), 'assembler-snapshot-'));
  try {
    await writeFile(join(project, 'flow.ts'), 'export default async () => {};');
    await writeFile(join(project, '.env'), 'SECRET=not-for-snapshot');
    await mkdir(join(project, 'release'));
    await writeFile(join(project, 'release', 'assembler-0.1.0-linux-x64.tar.gz'), 'generated archive');
    await writeFile(join(project, 'release', 'notes.md'), 'keep project release notes');
    const job = await enqueue(project, 'flow.ts', {}, '', defaults);
    await assert.rejects(access(join(runDirectory(project, job.id), 'source', '.env')));
    await assert.rejects(access(join(runDirectory(project, job.id), 'source', 'release', 'assembler-0.1.0-linux-x64.tar.gz')));
    await access(join(runDirectory(project, job.id), 'source', 'release', 'notes.md'));
    await assert.rejects(enqueue(project, '../elsewhere.ts', {}, '', defaults));
    await symlink('/etc/passwd', join(project, 'outside'));
    await assert.rejects(enqueue(project, 'flow.ts', {}, '', defaults), /symlinks/);
  } finally { await rm(project, { recursive: true, force: true }); }
});
