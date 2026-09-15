import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function loginToken(signal?: AbortSignal) {
  try {
    // Deliberately bypass Context.exec: its stdout is persisted in run logs.
    const { stdout } = await promisify(execFile)('gh', ['auth', 'token', '--hostname', 'github.com'],
      { encoding: 'utf8', timeout: 10_000, signal, maxBuffer: 16_384 });
    if (!stdout.trim()) throw new Error('Empty token');
    return stdout.trim();
  } catch {
    throw new Error('Cannot read GitHub login. Run gh auth login as the workflow user, or supply githubToken.');
  }
}

export async function prepareGitHubToken(input: { githubToken?: string; githubAuth?: 'gh' }, signal?: AbortSignal,
  readToken: (signal?: AbortSignal) => Promise<string> = loginToken) {
  if (input.githubToken && input.githubAuth) throw new Error('Choose githubToken or githubAuth, not both');
  if (input.githubToken) {
    try { return { path: await realpath(input.githubToken), cleanup: async () => {} }; }
    catch { throw new Error('githubToken file does not exist or is inaccessible. Supply a plain token file, or opt in to the existing login with --input \'{"githubAuth":"gh"}\'.'); }
  }
  if (input.githubAuth !== 'gh') throw new Error('GitHub credentials required. Use --input \'{"githubAuth":"gh"}\' to share your existing gh login with the sandbox, or supply githubToken for a repository-scoped token.');
  const token = await readToken(signal);
  const directory = await mkdtemp(join(tmpdir(), 'assembler-github-'));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const path = join(directory, 'token');
    await writeFile(path, token, { mode: 0o600, flag: 'wx' });
    return { path, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
