import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import type { Workflow } from './index.js';

const builtins: Record<string, string> = { build: 'build', 'task-to-pr': 'build', 'fetch-task': 'fetch-task', 'fix-checks': 'fix-checks', 'review-pr': 'review-pr' };
export function resolveWorkflow(project: string, name: string) {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  if (Object.hasOwn(builtins, name)) return { builtin: true, path: fileURLToPath(new URL(`./${builtins[name]}${extension}`, import.meta.url)) };
  return { builtin: false, path: name.endsWith('.ts') || name.endsWith('.js') ? resolve(project, name) : join(project, '.assembler', 'workflows', `${name}.ts`) };
}
export async function loadWorkflow(path: string): Promise<Workflow> {
  const loaded = (await tsImport(path, import.meta.url)).default;
  const workflow = typeof loaded === 'function' ? loaded : loaded?.default;
  if (typeof workflow !== 'function') throw new Error('Workflow must default-export a function');
  return workflow;
}
