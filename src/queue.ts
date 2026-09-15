import { cp, mkdir, realpath, symlink, rm, open, lstat, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config, RunRecord } from './index.js';
import { atomicJSON, exists, newRunId, readJSON, runDirectory } from './runs.js';
import { resolveWorkflow } from './workflows.js';

export interface Request { id: string; name: string; project: string; entry: string; input: unknown; task: string; config: Config; createdAt: string }
export const workerRoot = (project: string) => join(project, '.assembler');
export function sibling(name: string) { return fileURLToPath(new URL(`./${name}${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url)); }

export async function enqueue(project: string, name: string, input: unknown, task: string, config: Config) {
  if (process.platform !== 'linux') throw new Error('Detached execution currently requires Linux (flock)');
  const resolved = resolveWorkflow(project, name);
  const original = await realpath(resolved.path);
  const relativeEntry = relative(project, original);
  if (relativeEntry.startsWith('..' + sep) || relativeEntry === '..') throw new Error('Detached workflows must live inside the project');
  const id = newRunId();
  const dir = runDirectory(project, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const source = join(dir, 'source');
    let count = 0, size = 0;
    const filter = async (path: string) => {
      const rel = relative(project, path);
      const parts = rel.split(sep);
      if (parts[0] === 'release' && parts.length === 2 && /^assembler-.*\.tar\.gz(?:\.sha256)?$/.test(parts[1])) return false;
      if (parts.some(part => ['.git', 'node_modules', '.codex', '.ssh', '.env'].includes(part) || part.startsWith('.env.'))) return false;
      if (parts[0] === '.assembler' && parts.length > 1 && parts[1] !== 'workflows') return false;
      // No symlink dereferencing into unrelated workspaces or credentials.
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Snapshot does not support symlinks: ${rel}`);
      if (info.isFile()) { size += info.size; count++; }
      if (count > 10_000 || size > 64 * 1024 * 1024) throw new Error('Workflow snapshot exceeds 10,000 files / 64 MB');
      return true;
    };
    await mkdir(source);
    for (const entry of await readdir(project)) {
      if (entry === '.assembler') {
        const workflows = join(project, entry, 'workflows');
        if (await exists(workflows)) {
          await mkdir(join(source, entry));
          await cp(workflows, join(source, entry, 'workflows'), { recursive: true, filter });
        }
      } else await cp(join(project, entry), join(source, entry), { recursive: true, filter });
    }
    const installation = dirname(fileURLToPath(import.meta.url));
    const dependencies = join(dirname(installation), 'node_modules');
    await symlink(await exists(join(project, 'node_modules')) ? join(project, 'node_modules') : dependencies, join(source, 'node_modules'), 'dir');
    const entry = join(source, relativeEntry);
    const request: Request = { id, name, project, entry, input, task, config, createdAt: new Date().toISOString() };
    await atomicJSON(join(dir, 'request.json'), request);
    const record: RunRecord = { schemaVersion: 1, id, status: 'queued', workflow: name, agent: config.agent, createdAt: request.createdAt, rows: [], outputs: [] };
    // Publication point: only complete submissions have a run.json.
    await atomicJSON(join(dir, 'run.json'), record);
    return record;
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

export async function startWorker(project: string, concurrency?: number) {
  if (process.platform !== 'linux') throw new Error('Detached execution currently requires Linux (flock)');
  const root = workerRoot(project);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (concurrency !== undefined) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Concurrency must be an integer from 1 to 32');
    await atomicJSON(join(root, 'worker-settings.json'), { concurrency });
  }
  await rm(join(root, 'worker.stop'), { force: true });
  const ready = async () => {
    try {
      const info = await readJSON<{ time: number; pid: number }>(join(root, 'worker.json'));
      process.kill(info.pid, 0);
      return Date.now() - info.time < 3000;
    } catch { return false; }
  };
  if (await ready()) return;
  const log = await open(join(root, 'worker.log'), 'a', 0o600);
  try {
    // Kernel-held lock survives concurrent submitters and releases on process death.
    const child = spawn('flock', ['--nonblock', '--no-fork', join(root, 'worker.lock'), process.execPath, ...process.execArgv, sibling('worker'), project], {
      cwd: project, detached: true, stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
  for (let attempt = 0; attempt < 50; attempt++) { if (await ready()) return; await delay(100); }
  throw new Error(`Worker did not start; inspect ${join(root, 'worker.log')}`);
}

export { staleRun } from './runs.js';
