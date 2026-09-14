export function repositoryURL(value: string): string {
  const name = value.replace(/^https:\/\/github\.com\//, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error('Use a public GitHub repository: owner/repo or https://github.com/owner/repo');
  }
  return `https://github.com/${name}.git`;
}
import { writeFile } from 'node:fs/promises';
import type { Result } from '../../src/index.js';

export async function collectPatch(sandbox: { exec(command: string[]): Promise<Result> }, revision: string, path: string) {
  await sandbox.exec(['sh', '-c', 'git add -N . && git diff --binary "$1" > /tmp/changes.patch', 'collect', revision]);
  // Docker's archive API cannot see runsc's private tmpfs. Read through the runtime.
  const patch = await sandbox.exec(['cat', '/tmp/changes.patch']);
  if (patch.stdoutTruncated) throw new Error('Patch exceeds this demo\'s 64 KB capture limit; see command log');
  await writeFile(path, patch.stdout, { flag: 'wx', mode: 0o600 });
}
