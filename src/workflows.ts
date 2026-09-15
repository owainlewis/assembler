import { resolve, join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import type { Workflow } from './index.js';

export function resolveWorkflow(project: string, name: string) {
  return { path: name.endsWith('.ts') || name.endsWith('.js') ? resolve(project, name) : join(project, '.assembler', 'workflows', `${name}.ts`) };
}
export async function loadWorkflow(path: string): Promise<Workflow> {
  const loaded = (await tsImport(path, import.meta.url)).default;
  const workflow = typeof loaded === 'function' ? loaded : loaded?.default;
  if (typeof workflow !== 'function') throw new Error('Workflow must default-export a function');
  return workflow;
}
