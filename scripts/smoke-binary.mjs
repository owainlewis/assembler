import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const label = `assembler-${pkg.version}-${process.platform}-${process.arch}`;
const archive = resolve('release', `${label}.tar.gz`);
const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
assert.equal((await readFile(`${archive}.sha256`, 'utf8')).split(' ')[0], digest);
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'assembler-release-smoke-')));
const prefix = join(temporary, 'installation with spaces');
const project = join(temporary, 'project');
let cli;
const run = (command, args, cwd = temporary) => execFileSync(command, args, {
  cwd, encoding: 'utf8', timeout: 30_000,
  env: { ...process.env, PATH: '/usr/bin:/bin', NODE_OPTIONS: '', CODEX_HOME: '' },
});
try {
  run('tar', ['-xzf', archive, '-C', temporary]);
  run('sh', [join(temporary, label, 'install.sh'), prefix]);
  cli = join(prefix, 'bin', 'assembler');
  assert.match(run(cli, ['--help']), /Assembler/);
  assert.equal(run(cli, ['--version']).trim(), pkg.version);
  await mkdir(project);
  await writeFile(join(project, 'hello.ts'), `export default async (ctx: any) => {
    const result = await ctx.exec([process.execPath, '-e', 'console.log("CHILD_OK")']);
    ctx.output('Result', { text: result.stdout.trim(), project: ctx.project, runtime: process.execPath });
  };`);
  const record = JSON.parse(run(cli, ['run', 'hello.ts', '--json'], project));
  assert.equal(record.status, 'completed');
  assert.equal(record.outputs[0].value.text, 'CHILD_OK');
  assert.equal(record.outputs[0].value.project, project);
  assert.ok(record.outputs[0].value.runtime.startsWith(prefix));
  // Source examples (including Markdown-relative imports) can be loaded from the archive.
  const example = join(prefix, 'lib', 'assembler', `${pkg.version}-${process.platform}-${process.arch}`, 'app', 'examples', 'sandbox-delivery.ts');
  try { run(cli, ['run', example, '--input', '{"timeoutSeconds":0}', '--json'], project); assert.fail('Expected input validation'); }
  catch (error) {
    const rejected = JSON.parse(String(error.stdout));
    assert.equal(rejected.status, 'failed');
    assert.match(rejected.error, /timeoutSeconds/);
  }
  if (process.platform === 'linux') {
    const queued = JSON.parse(run(cli, ['run', 'hello.ts', '--detach', '--json'], project));
    let result;
    for (let i = 0; i < 100; i++) {
      result = JSON.parse(run(cli, ['runs', 'show', queued.id, '--json'], project));
      if (!['running', 'queued'].includes(result.status)) break;
      await delay(100);
    }
    assert.equal(result.status, 'completed');
    assert.equal(result.outputs[0].value.text, 'CHILD_OK');
    run(cli, ['worker', 'stop'], project);
    for (let i = 0; i < 100; i++) {
      const state = JSON.parse(run(cli, ['worker', 'status', '--json'], project));
      if (state.status === 'stopped') break;
      await delay(100);
    }
  }
  console.log('Release smoke passed: checksum, installation, dynamic TypeScript, private runtime, source example, and Linux worker.');
} finally {
  if (cli && process.platform === 'linux') { try { run(cli, ['worker', 'stop'], project); } catch {} }
  await rm(temporary, { recursive: true, force: true });
}
