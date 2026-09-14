import { readFile, readdir, realpath, rename, writeFile, access, open, stat, link, rm } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RunRecord } from './index.js';
import { plain, formatOutputs } from './display.js';

export const terminal = (status: string) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
export const newRunId = () => `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
export function runDirectory(project: string, id: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) throw new Error('Invalid run ID');
  return join(project, '.assembler', 'runs', id);
}
export async function atomicJSON(path: string, data: unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}
export async function exists(path: string) { try { await access(path); return true; } catch { return false; } }
export async function readJSON<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')); }
export async function readRun(project: string, id: string): Promise<RunRecord> {
  const root = await realpath(join(project, '.assembler', 'runs'));
  const dir = await realpath(runDirectory(project, id));
  if (!dir.startsWith(root + sep)) throw new Error('Run directory escapes the project');
  const record = await readJSON<RunRecord>(join(dir, 'run.json'));
  if (!record || record.id !== id || typeof record.status !== 'string' ||
      !Array.isArray(record.rows) || !Array.isArray(record.outputs)) throw new Error('Invalid run record');
  return record;
}
export async function listRuns(project: string): Promise<RunRecord[]> {
  const root = join(project, '.assembler', 'runs');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const records: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try { records.push(await readRun(project, entry.name)); }
    catch { /* A preparing or damaged run must not hide the remaining history. */ }
  }
  return records.sort((a, b) => b.id.localeCompare(a.id));
}
export function formatRun(record: RunRecord) {
  return plain([
    `${record.id} · ${record.status} · ${record.workflow ?? 'workflow'}`,
    record.error ? `Reason: ${record.error}` : '',
    record.cleanup ? `Cleanup: ${record.cleanup}` : '',
    ...record.rows.map(row => `  ${row.status}  ${row.name}${row.error ? ` — ${row.error}` : ''}`),
  ].filter(Boolean).join('\n')) + formatOutputs(record);
}

// Immutable publication: dispatch and queued cancellation compete for one claim.
// A hard link publishes the complete decision atomically, with no stale lock.
export async function claimRun(project: string, id: string, status: 'running' | 'cancelled') {
  const path = join(runDirectory(project, id), 'claim.json');
  const tmp = path + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, JSON.stringify({ status }), { mode: 0o600 });
  try {
    try { await link(tmp, path); return { status, won: true }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const claim = await readJSON<{ status: 'running' | 'cancelled' }>(path);
    if (!['running', 'cancelled'].includes(claim.status)) throw new Error('Invalid run claim');
    return { status: claim.status, won: false };
  } finally { await rm(tmp, { force: true }); }
}

export async function cancelRun(project: string, id: string) {
  const record = await readRun(project, id);
  if (terminal(record.status)) return record.status;
  await writeFile(join(runDirectory(project, id), 'cancel'), '', { mode: 0o600 });
  if (record.status === 'queued' && (await claimRun(project, id, 'cancelled')).status === 'cancelled') {
    await atomicJSON(join(runDirectory(project, id), 'run.json'), { ...record, status: 'cancelled', cleanup: 'Not started' });
    return 'cancelled';
  }
  return 'cancellation requested';
}

export async function staleRun(project: string, record: RunRecord) {
  if (record.status !== 'running') return false;
  const dir = runDirectory(project, record.id);
  let heartbeat: { pid: number; time: number } | undefined;
  try { heartbeat = await readJSON(join(dir, 'heartbeat.json')); } catch { /* startup grace below */ }
  if (heartbeat) {
    try { process.kill(heartbeat.pid, 0); return false; } catch { /* execution disappeared */ }
  } else if (Date.now() - (await stat(join(dir, 'run.json'))).mtimeMs < 5000) return false;
  const latest = await readRun(project, record.id);
  if (latest.status !== 'running') return false;
  await atomicJSON(join(dir, 'run.json'), { ...latest, status: 'interrupted', error: 'Execution process disappeared. No automatic retry.', cleanup: 'Unknown: inspect workflow resources before rerunning.' });
  return true;
}

export async function streamLogs(project: string, id: string, options: {
  follow?: boolean; step?: string; json?: boolean; signal?: AbortSignal;
}, print: (value: string) => void = value => process.stdout.write(value)) {
  const dir = await realpath(runDirectory(project, id));
  const positions = new Map<string, number>();
  const decoders = new Map<string, StringDecoder>();
  let lastFile = '';
  while (!options.signal?.aborted) {
    let record = await readRun(project, id);
    if (await staleRun(project, record)) record = await readRun(project, id);
    let events: { data?: { log?: string; stepId?: string } }[] = [];
    try { events = (await readFile(join(dir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; } // tolerate an in-flight final line
    }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const selected = new Set(record.rows.filter(row => row.name === options.step || row.id === options.step).map(row => row.id));
    for (const row of record.rows) if (row.parentId && selected.has(row.parentId)) selected.add(row.id);
    if (options.step && !selected.size && (!options.follow || terminal(record.status))) throw new Error(`No step matching ${options.step}`);
    const files = new Set(events.filter(event => !options.step || selected.has(event.data?.stepId ?? '')).map(event => event.data?.log).filter((path): path is string => !!path));
    if (!options.step) files.add(join(dir, 'console.log'));
    for (const path of files) {
      let actual: string;
      try { actual = await realpath(resolve(dir, path)); } catch { continue; }
      if (!actual.startsWith(dir + sep)) throw new Error('Log path escapes the run directory');
      const handle = await open(actual, 'r');
      try {
        let offset = positions.get(actual) ?? 0;
        const size = (await handle.stat()).size;
        while (offset < size) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, size - offset));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) break;
          let decoder = decoders.get(actual);
          if (!decoder) { decoder = new StringDecoder('utf8'); decoders.set(actual, decoder); }
          const text = plain(decoder.write(buffer.subarray(0, bytesRead)));
          if (options.json) print(JSON.stringify({ id, log: actual, text }) + '\n');
          else {
            if (lastFile !== actual) print(`\n--- ${actual.slice(dir.length + 1)} ---\n`);
            print(text); lastFile = actual;
          }
          offset += bytesRead;
        }
        positions.set(actual, offset);
      } finally { await handle.close(); }
    }
    if (!options.follow || terminal(record.status)) return;
    await delay(250, undefined, { signal: options.signal }).catch(() => {});
  }
}
