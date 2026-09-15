import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveWorkflow } from '../src/workflows.js';

test('workflow names resolve only to project registrations, never a core registry', () => {
  for (const name of ['build', 'task-to-pr', 'fix-checks', 'fetch-task', 'review-pr', 'constructor', 'toString']) {
    assert.deepEqual(resolveWorkflow('/project', name), { path: join('/project', '.assembler', 'workflows', `${name}.ts`) });
  }
  assert.equal(resolveWorkflow('/project', 'examples/task-to-pr.ts').path, '/project/examples/task-to-pr.ts');
  assert.equal(resolveWorkflow('/project', '/elsewhere/custom.js').path, '/elsewhere/custom.js');
});
