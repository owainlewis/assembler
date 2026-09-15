import { cp, mkdir, mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!['linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch))
  throw new Error('Build on Linux/macOS x64 or arm64; cross-compilation is not supported');
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid release version');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${pkg.version}`)
  throw new Error('Release tag must match package.json version');
const label = `assembler-${pkg.version}-${process.platform}-${process.arch}`;
const temporary = await mkdtemp(join(tmpdir(), 'assembler-package-'));
const bundle = join(temporary, label);
const app = join(bundle, 'app');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
try {
  run('npm', ['run', 'build']);
  await mkdir(join(bundle, 'bin'), { recursive: true });
  await mkdir(join(bundle, 'runtime'));
  await mkdir(app);
  // Explicit allowlist: no .assembler runs, credentials, workspaces or local config.
  for (const file of ['dist', 'src', 'examples', 'docs', 'package.json', 'package-lock.json', 'README.md', 'LICENSE'])
    await cp(join(root, file), join(app, file), { recursive: true });
  run('npm', ['ci', '--omit=dev'], app);
  await cp(process.execPath, join(bundle, 'runtime', 'node'));
  await chmod(join(bundle, 'runtime', 'node'), 0o755);
  // Include Node's license alongside its bundled runtime.
  const licenseURL = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
  const license = await fetch(licenseURL, { signal: AbortSignal.timeout(30_000) });
  if (!license.ok) throw new Error(`Cannot obtain Node license: ${license.status}`);
  await writeFile(join(bundle, 'runtime', 'LICENSE'), await license.text());
  await cp(join(root, 'scripts', 'assembler.sh'), join(bundle, 'bin', 'assembler'));
  await chmod(join(bundle, 'bin', 'assembler'), 0o755);
  await cp(join(root, 'scripts', 'install-binary.sh'), join(bundle, 'install.sh'));
  await chmod(join(bundle, 'install.sh'), 0o755);
  await writeFile(join(bundle, 'VERSION'), `${pkg.version}\n`);
  const output = join(root, 'release');
  await mkdir(output, { recursive: true });
  const archive = join(output, `${label}.tar.gz`);
  run('tar', ['-czf', archive, '-C', temporary, label]);
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  ${label}.tar.gz\n`);
  console.log(`Release archive: ${archive}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
