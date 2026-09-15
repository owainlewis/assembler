export function repositoryURL(value: string): string {
  const name = value.replace(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error('Use a public GitHub repository: owner/repo or a GitHub HTTPS/SSH URL');
  }
  return `https://github.com/${name}.git`;
}
import { writeFile } from 'node:fs/promises';
import type { Result } from '../../src/index.js';

export async function resolveRepository(ctx: { exec(command: string[], options: { allowFailure: boolean }): Promise<Result> }, override?: string) {
  if (override !== undefined) return repositoryURL(override);
  const remote = await ctx.exec(['git', 'remote', 'get-url', 'origin'], { allowFailure: true });
  if (remote.exitCode !== 0 || !remote.stdout.trim()) {
    throw new Error('No Git origin remote in the current project. Run from a Git checkout, use --project, or pass --input \'{"repo":"owner/repo"}\'.');
  }
  if (remote.stdoutTruncated) throw new Error('Git origin URL was truncated');
  return repositoryURL(remote.stdout.trim());
}

export async function collectPatch(sandbox: { exec(command: string[]): Promise<Result> }, revision: string, path: string) {
  await sandbox.exec(['sh', '-c', 'git add -N . && git diff --binary "$1" > /tmp/changes.patch', 'collect', revision]);
  // Docker's archive API cannot see runsc's private tmpfs. Read through the runtime.
  const patch = await sandbox.exec(['cat', '/tmp/changes.patch']);
  if (patch.stdoutTruncated) throw new Error('Patch exceeds this demo\'s 64 KB capture limit; see command log');
  await writeFile(path, patch.stdout, { flag: 'wx', mode: 0o600 });
}
