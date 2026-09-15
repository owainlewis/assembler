import { type Context, type Result, execute } from '../../src/index.js';
import { dirname, join } from 'node:path';

export interface SandboxFiles {
  workspace: string;
  checks?: string;
  codex: string;
  auth: string;
  certificates: string;
  github?: { cli: string; token: string };
}

// Example-local helper, not an Assembler backend or built-in workflow.
export function containerArgs(name: string, image: string, files: SandboxFiles, agent: boolean): string[] {
  const mount = (source: string, target: string, readonly = true) => {
    if (source.includes(',')) throw new Error('Docker bind paths cannot contain commas in this demo');
    return ['--mount', `type=bind,src=${source},dst=${target}${readonly ? ',readonly' : ''}`];
  };
  return ['docker', 'create', '--name', name, '--label', 'assembler.demo=gvisor',
    '--runtime=runsc', '--network', agent ? 'bridge' : 'none',
    '--user', `${process.getuid!()}:${process.getgid!()}`,
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--memory=2g', '--cpus=2', '--pids-limit=256',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--tmpfs', `/home/node:rw,nosuid,nodev,size=128m,uid=${process.getuid!()},gid=${process.getgid!()}`,
    '--tmpfs', `/home/node/.codex:rw,nosuid,nodev,size=64m,uid=${process.getuid!()},gid=${process.getgid!()}`,
    '--workdir', '/workspace',
    ...mount(files.workspace, '/workspace', !agent),
    ...(files.checks ? mount(files.checks, '/checks') : []),
    ...(agent ? [
      ...mount(files.codex, '/opt/codex'),
      ...mount(join(dirname(files.codex), 'codex-code-mode-host'), '/opt/codex-code-mode-host'),
      ...mount(files.certificates, '/etc/ssl/certs/ca-certificates.crt'),
      ...mount(files.auth, '/home/node/.codex/auth.json'),
      ...(files.github ? [...mount(files.github.cli, '/opt/gh'), ...mount(files.github.token, '/run/secrets/github-token')] : []),
    ] : []),
    image, 'sleep', 'infinity'];
}

export class Sandbox {
  constructor(private ctx: Context, readonly name: string, private artifacts: string) {}

  async start(image: string, files: SandboxFiles, agent: boolean) {
    await this.ctx.exec(containerArgs(this.name, image, files, agent));
    await this.ctx.exec(['docker', 'start', this.name]);
    const result = await this.exec(['dmesg']);
    if (!/gVisor/i.test(result.stdout)) throw new Error('Container did not report the gVisor kernel');
    return result.stdout;
  }

  exec(command: string[], options: { input?: string; allowFailure?: boolean } = {}): Promise<Result> {
    return this.ctx.exec(['docker', 'exec', ...(options.input !== undefined ? ['-i'] : []), this.name, ...command], options);
  }

  async runPrompt(prompt: string, timeoutSeconds = 180, github = false, schema?: object) {
    if (schema) await this.exec(['sh', '-c', 'cat > /tmp/result-schema.json'], { input: JSON.stringify(schema) });
    const command = ['timeout', String(timeoutSeconds), '/opt/codex', 'exec', '--skip-git-repo-check', '--ephemeral',
      '--disable', 'apps',
      '--ignore-user-config', '--ignore-rules', '--sandbox', 'danger-full-access',
      '--color', 'never', ...(schema ? ['--output-schema', '/tmp/result-schema.json'] : []), '--output-last-message', '/tmp/answer.md', '-'];
    // The token value never enters host command arguments or workflow outputs.
    await this.exec(github ? ['sh', '-ec',
      'export HOME=/home/node PATH=/opt:$PATH; GH_TOKEN=$(cat /run/secrets/github-token); export GH_TOKEN; gh auth setup-git; exec "$@"',
      'delivery', ...command] : command, { input: prompt });
    return (await this.exec(['cat', '/tmp/answer.md'])).stdout;
  }

  async remove() {
    // docker exec cancellation does not remove a daemon-owned container.
    // Cleanup deliberately uses a fresh signal, even after Ctrl-C.
    const result = await execute(['docker', 'rm', '--force', this.name], this.ctx.project,
      join(this.artifacts, `${this.name}-cleanup.log`), new AbortController().signal, 15_000);
    if (result.exitCode && !result.stderr.includes('No such container')) {
      throw new Error(`Cleanup failed for ${this.name}: ${result.stderr}`);
    }
  }
}
