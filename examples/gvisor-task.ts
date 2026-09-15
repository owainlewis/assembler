import { defineWorkflow, z } from '../src/index.js';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from './gvisor/sandbox.js';
import { collectPatch, repositoryURL, resolveRepository } from './gvisor/repository.js';

export default defineWorkflow({
  input: z.object({
    repo: z.string().transform(repositoryURL).optional(),
    prompt: z.string().trim().min(1, 'Pass --prompt "Review the code"'),
    image: z.string().default('node:22-bookworm'),
    codex: z.string().default(join(homedir(), '.local/bin/codex')),
    auth: z.string().default(join(homedir(), '.codex/auth.json')),
    certificates: z.string().default('/etc/ssl/certs/ca-certificates.crt'),
    timeoutSeconds: z.number().int().min(1).max(1200).default(600),
  }),
  async run(ctx) {
    const repository = await ctx.step('Resolve repository', () => resolveRepository(ctx, ctx.input.repo));
    ctx.output('Repository', repository, { detail: true });
    await ctx.step('Check prerequisites', async () => {
      if (process.platform !== 'linux') throw new Error('This example requires Linux');
      if (ctx.config.agent !== 'codex') throw new Error('This example currently supports Codex');
      const info = await ctx.exec(['docker', 'info', '--format', '{{json .Runtimes}}']);
      if (!JSON.parse(info.stdout).runsc) throw new Error('Docker needs the runsc runtime');
    });
    const files = {
      codex: await realpath(ctx.input.codex),
      auth: await realpath(ctx.input.auth),
      certificates: await realpath(ctx.input.certificates),
      workspace: '',
    };
    const base = join(ctx.project, '.assembler', 'demos');
    await mkdir(base, { recursive: true });
    const artifacts = await mkdtemp(join(base, 'task-'));
    files.workspace = join(artifacts, 'workspace');
    const sandbox = new Sandbox(ctx, `assembler-task-${artifacts.split('task-').at(-1)!.toLowerCase()}`, artifacts);
    ctx.output('Artifacts', artifacts, { detail: true });
    let failure: unknown;
    let revision = '';
    try {
      await mkdir(files.workspace);
      await ctx.step('Sandbox ready', async () => {
        await ctx.exec(['docker', 'pull', ctx.input.image]);
        const image = (await ctx.exec(['docker', 'image', 'inspect', '--format', '{{.Id}}', ctx.input.image])).stdout.trim();
        ctx.output('Image', image, { detail: true });
        await sandbox.start(image, files, true);
        await sandbox.exec(['env', 'GIT_TERMINAL_PROMPT=0', 'git', 'clone', '--depth=1', '--single-branch', '--', repository, '.']);
        revision = (await sandbox.exec(['git', 'rev-parse', 'HEAD'])).stdout.trim();
        ctx.output('Source', { repository, commit: revision }, { detail: true });
        // Fetch-only demo: no GitHub credentials and no usable push URL.
        await sandbox.exec(['git', 'remote', 'set-url', '--push', 'origin', 'DISABLED']);
      });
      await ctx.step('Agent working', async () => {
        const instructions = await readFile(new URL('./gvisor/prompts/task.md', import.meta.url), 'utf8');
        const result = await sandbox.runPrompt(`${instructions}\n${ctx.input.prompt}`, ctx.input.timeoutSeconds);
        ctx.output('Result', result);
      });
      await ctx.step('Save patch', async () => {
        // Capture tracked and non-ignored new files without executing any code on the host.
        await collectPatch(sandbox, revision, join(artifacts, 'changes.patch'));
        ctx.output('Patch', join(artifacts, 'changes.patch'), { detail: true });
        ctx.output('Changes', (await readFile(join(artifacts, 'changes.patch'), 'utf8')).trim() ? 'Patch saved; inspect it in the run details before applying.' : 'No files changed.');
      });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const cleanup = async () => {
        await sandbox.remove();
        // This exact path was created by mkdtemp above. Never remove a user's checkout.
        await rm(files.workspace, { recursive: true, force: true });
      };
      try {
        if (ctx.signal.aborted) await cleanup();
        else await ctx.step('Cleanup complete', cleanup);
        ctx.output('Cleanup', 'Container and checkout removed; logs retained.');
      } catch (error) {
        if (failure) ctx.output('Cleanup warning', String(error));
        else throw error;
      }
    }
  },
});
