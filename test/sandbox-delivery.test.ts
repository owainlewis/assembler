import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireReady } from '../examples/gvisor/delivery.js';
import { containerArgs, Sandbox } from '../examples/gvisor/sandbox.js';
import workflow from '../examples/sandbox-delivery.js';
import { defaults } from '../src/index.js';
import type { Feedback } from '../examples/lib/github.js';
import { prepareGitHubToken } from '../examples/gvisor/credentials.js';

test('GitHub login sharing is explicit and the temporary token is private and removable', async () => {
  const unread = async () => { throw new Error('must not read login'); };
  await assert.rejects(prepareGitHubToken({}, undefined, unread), /GitHub credentials required/);
  await assert.rejects(prepareGitHubToken({ githubToken: '/missing/assembler-token' }, undefined, unread), /file does not exist/);
  await assert.rejects(prepareGitHubToken({ githubAuth: 'gh', githubToken: '/token' }, undefined, unread), /not both/);
  const credentials = await prepareGitHubToken({ githubAuth: 'gh' }, undefined, async () => 'test-only-secret');
  try {
    assert.equal(await readFile(credentials.path, 'utf8'), 'test-only-secret');
    assert.equal((await stat(credentials.path)).mode & 0o777, 0o600);
  } finally { await credentials.cleanup(); }
  await assert.rejects(access(credentials.path));
  const explicit = await prepareGitHubToken({ githubToken: process.execPath }, undefined, unread);
  await explicit.cleanup();
  await access(process.execPath); // Caller-owned files must never be deleted.
});

const green: Feedback = { head: 'head', ci: 'passed', items: [], checks: [], reviewDecision: '', isDraft: false, mergeable: 'MERGEABLE' };
test('sandbox completion is bound to the head and all readiness gates', () => {
  requireReady(green, 'head');
  for (const change of [
    { head: 'other' }, { ci: 'pending' }, { ci: 'failed' },
    { items: [{ id: '1', threadId: '1', body: 'Fix', fingerprint: '1' }] },
    { reviewDecision: 'CHANGES_REQUESTED' }, { reviewDecision: 'REVIEW_REQUIRED' },
    { isDraft: true }, { mergeable: 'UNKNOWN' }, { mergeable: 'CONFLICTING' },
  ]) assert.throws(() => requireReady({ ...green, ...change } as Feedback, 'head'));
});

test('GitHub credentials are opt-in, readonly, and never mounted in the verifier', () => {
  const files = { workspace: '/work', codex: '/codex', auth: '/auth', certificates: '/ca', github: { cli: '/gh', token: '/token' } };
  const args = containerArgs('delivery', 'image', files, true);
  assert.ok(args.includes('type=bind,src=/token,dst=/run/secrets/github-token,readonly'));
  assert.ok(args.includes('type=bind,src=/gh,dst=/opt/gh,readonly'));
  assert.ok(!containerArgs('verify', 'image', files, false).join(' ').includes('/token'));
});

test('one sandbox agent call reads the token inside the container, not command arguments', async () => {
  const commands: string[][] = [];
  const sandbox = new Sandbox({ exec: async (command: string[]) => {
    commands.push(command);
    return { stdout: 'answer', stderr: '', exitCode: 0, log: '' };
  } } as any, 'test', '/tmp');
  assert.equal(await sandbox.runPrompt('task', 60, true), 'answer');
  assert.equal(commands.length, 2);
  assert.ok(commands[0].includes('export HOME=/home/node PATH=/opt:$PATH; GH_TOKEN=$(cat /run/secrets/github-token); export GH_TOKEN; gh auth setup-git; exec "$@"'));
  assert.ok(commands[0].includes('danger-full-access'));
});

// Exercise failure lifecycle without Docker or spending tokens. Actual sandbox
// commands still go through the workflow's Context; only daemon removal is stubbed.
test('delivery lifecycle preserves failed work and only deletes a verified successful checkout', async () => {
  const original = Sandbox.prototype.remove;
  try {
    for (const failure of ['agent', 'patch', 'branch', 'success', 'blocked', 'no_changes']) {
      const project = await mkdtemp(join(tmpdir(), 'assembler-delivery-lifecycle-'));
      const outputs: any[] = [], commands: string[][] = [];
      let removals = 0;
      let revisions = 0;
      Sandbox.prototype.remove = async () => { removals++; };
      const ctx: any = {
        project, task: 'task', config: defaults, signal: new AbortController().signal,
        input: { prompt: 'Fix issue 123', repo: 'owner/repo', codex: process.execPath,
          auth: process.execPath, gh: process.execPath, githubToken: process.execPath, certificates: process.execPath },
        output: (name: string, value: unknown) => outputs.push({ name, value }),
        step: async (name: string, action: () => Promise<unknown>) => {
          if (name !== 'Verify PR completion') return action();
          // Simulate a quiet feedback window without sleeping in a unit test.
          const originalNow = Date.now;
          let time = 0;
          Date.now = () => time += 30_000;
          try { return await action(); } finally { Date.now = originalNow; }
        },
        exec: async (command: string[]) => {
          commands.push(command);
          const text = command.join(' ');
          if (text.includes('gh auth setup-git') && failure === 'agent') throw new Error('agent timed out');
          let stdout = '';
          if (text.includes('docker info')) stdout = '{"runsc":{}}';
          if (text.endsWith('dmesg')) stdout = 'gVisor';
          if (text.includes('rev-parse HEAD')) stdout = ++revisions === 1 || ['blocked', 'no_changes'].includes(failure) ? 'base' : 'head';
          if (text.endsWith('cat /tmp/answer.md')) stdout = JSON.stringify({ status: ['blocked', 'no_changes'].includes(failure) ? failure : 'ready', summary: 'Task needs clarification' });
          if (text.includes('branch --show-current')) stdout = commands.find(c => c.includes('switch'))!.at(-1)!;
          if (text.includes('ls-remote') && failure === 'branch') stdout = 'existing';
          if (text.endsWith('cat /tmp/changes.patch')) return { stdout: 'patch', stdoutTruncated: failure === 'patch', stderr: '', exitCode: 0, log: '' };
          if (text.startsWith('gh pr list')) stdout = JSON.stringify([{ number: 1, url: 'https://github.com/owner/repo/pull/1', baseRefName: 'main', headRefOid: 'head', isCrossRepository: false }]);
          if (text.includes('statusCheckRollup')) stdout = JSON.stringify({ headRefOid: 'head', state: 'OPEN', reviewDecision: '', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
          if (text.includes('reviewThreads')) stdout = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } });
          if (text.includes('--slurp')) stdout = '[[]]';
          return { stdout, stderr: '', exitCode: 0, log: '' };
        },
      };
      try {
        if (failure === 'success') {
          await workflow(ctx);
          assert.equal(removals, 2);
          assert.equal(outputs.at(-1).name, 'Pull request');
          const artifacts = outputs.find(o => o.name === 'Artifacts').value;
          await assert.rejects(access(join(artifacts, 'workspace')));
          await access(join(artifacts, 'changes.patch'));
        } else if (['blocked', 'no_changes'].includes(failure)) {
          if (failure === 'blocked') await assert.rejects(workflow(ctx), /Task needs clarification/);
          else await workflow(ctx);
          const artifacts = outputs.find(o => o.name === 'Artifacts').value;
          await assert.rejects(access(join(artifacts, 'workspace')));
          assert.ok(!commands.some(c => c.join(' ').startsWith('gh pr list')));
          assert.ok(!outputs.some(o => o.name === 'Recovery'));
        } else {
          await assert.rejects(workflow(ctx), /agent timed out|capture limit|branch already exists/);
          assert.equal(removals, 1);
          const artifacts = outputs.find(o => o.name === 'Artifacts').value;
          await access(join(artifacts, 'workspace'));
          assert.ok(!outputs.some(o => o.name === 'Ready'));
        }
        assert.equal(commands.filter(c => c.join(' ').includes('gh auth setup-git')).length, failure === 'branch' ? 0 : 1);
      } finally { await rm(project, { recursive: true, force: true }); }
    }
  } finally { Sandbox.prototype.remove = original; }
});
