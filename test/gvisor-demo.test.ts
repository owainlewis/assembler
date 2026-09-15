import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containerArgs } from '../examples/gvisor/sandbox.js';
import { collectPatch, repositoryURL, resolveRepository } from '../examples/gvisor/repository.js';
import { execute } from '../src/index.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('patch collection reads through the runtime and compares against the original revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assembler-patch-'));
  const commands: string[][] = [];
  try {
    await collectPatch({ exec: async command => {
      commands.push(command);
      return { exitCode: 0, stdout: command[0] === 'cat' ? 'patch content\n' : '', stderr: '', log: '' };
    } }, 'original-sha', join(dir, 'changes.patch'));
    assert.equal(commands[0].at(-1), 'original-sha');
    assert.deepEqual(commands[1], ['cat', '/tmp/changes.patch']);
    assert.equal(await readFile(join(dir, 'changes.patch'), 'utf8'), 'patch content\n');
  } finally { await rm(dir, { recursive: true }); }
});

test('patch collection refuses truncated results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assembler-patch-'));
  const path = join(dir, 'changes.patch');
  try {
    await assert.rejects(collectPatch({ exec: async () => ({
      exitCode: 0, stdout: 'partial', stderr: '', log: '', stdoutTruncated: true,
    }) }, 'original-sha', path), /capture limit/);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true }); }
});

test('repository tasks normalize GitHub URLs to credential-free HTTPS', () => {
  assert.equal(repositoryURL('owainlewis/assembler'), 'https://github.com/owainlewis/assembler.git');
  assert.equal(repositoryURL('https://github.com/owainlewis/neo.git'), 'https://github.com/owainlewis/neo.git');
  assert.equal(repositoryURL('git@github.com:owainlewis/neo.git'), 'https://github.com/owainlewis/neo.git');
  assert.equal(repositoryURL('ssh://git@github.com/owainlewis/neo.git'), 'https://github.com/owainlewis/neo.git');
  for (const value of ['--upload-pack=evil', 'file:///root/repo', 'https://evil.com/x/y', 'x/../y', 'x/y?token=secret']) {
    assert.throws(() => repositoryURL(value), /public GitHub/);
  }
});

test('repository discovery uses the selected checkout origin and permits explicit override', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assembler-origin-'));
  const ctx = { exec: (command: string[]) => execute(command, dir, join(dir, 'git.log'), new AbortController().signal, 5000) };
  try {
    await assert.rejects(resolveRepository(ctx), /No Git origin/);
    await ctx.exec(['git', 'init', '--quiet']);
    await assert.rejects(resolveRepository(ctx), /No Git origin/);
    await ctx.exec(['git', 'remote', 'add', 'origin', 'git@github.com:owainlewis/neo.git']);
    assert.equal(await resolveRepository(ctx), 'https://github.com/owainlewis/neo.git');
    await ctx.exec(['git', 'remote', 'set-url', 'origin', 'https://github.com/example/another.git']);
    assert.equal(await resolveRepository(ctx), 'https://github.com/example/another.git');
    assert.equal(await resolveRepository({ exec: async () => { throw new Error('must not query Git'); } }, 'example/override'), 'https://github.com/example/override.git');
    await ctx.exec(['git', 'remote', 'set-url', 'origin', 'git@gitlab.com:example/repo.git']);
    await assert.rejects(resolveRepository(ctx), /public GitHub/);
    await assert.rejects(resolveRepository({ exec: async () => ({ exitCode: 0, stdout: 'example/repo', stderr: '', log: '', stdoutTruncated: true }) }), /truncated/);
  } finally { await rm(dir, { recursive: true }); }
});

test('repository tasks do not mount the demo fixture tests', () => {
  const args = containerArgs('task', 'image', { ...files, checks: undefined }, true);
  assert.ok(!args.join(' ').includes('/checks'));
});

const files = { workspace: '/demo/work', checks: '/demo/checks', codex: '/bin/codex', auth: '/private/auth.json', certificates: '/etc/ssl/certs/ca-certificates.crt' };

test('gvisor demo always requests runsc and restrictive container settings', () => {
  const args = containerArgs('test-agent', 'image@sha256:abc', files, true);
  for (const value of ['--runtime=runsc', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=2g', '--pids-limit=256']) {
    assert.ok(args.includes(value));
  }
  assert.ok(!args.includes('--privileged'));
  assert.ok(!args.join(' ').includes('docker.sock'));
  assert.ok(args.includes('type=bind,src=/demo/work,dst=/workspace'));
  assert.ok(args.includes('type=bind,src=/private/auth.json,dst=/home/node/.codex/auth.json,readonly'));
});

test('verifier is offline, mounts code and tests readonly, and has no agent credentials', () => {
  const args = containerArgs('test-verify', 'image', files, false);
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.ok(args.includes('type=bind,src=/demo/work,dst=/workspace,readonly'));
  assert.ok(args.includes('type=bind,src=/demo/checks,dst=/checks,readonly'));
  assert.ok(!args.join(' ').includes('/private/auth.json'));
  assert.ok(!args.join(' ').includes('/bin/codex'));
});

test('agent cannot edit the independently supplied tests', () => {
  const args = containerArgs('test-agent', 'image', files, true);
  assert.ok(args.includes('type=bind,src=/demo/checks,dst=/checks,readonly'));
});

test('ambiguous Docker bind paths are rejected', () => {
  assert.throws(() => containerArgs('test-agent', 'image', { ...files, workspace: '/demo,readonly' }, true), /commas/);
});
