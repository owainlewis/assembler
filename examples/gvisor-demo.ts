import { defineWorkflow, z } from '../src/index.js';
import { cp, mkdir, mkdtemp, readFile, realpath, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sandbox } from './gvisor/sandbox.js';

export default defineWorkflow({
  input: z.object({
    image: z.string().default('node:22-bookworm-slim'),
    codex: z.string().default(join(homedir(), '.local/bin/codex')),
    auth: z.string().default(join(homedir(), '.codex/auth.json')),
    certificates: z.string().default('/etc/ssl/certs/ca-certificates.crt'),
  }),
  async run(ctx) {
    const demo = fileURLToPath(new URL('./gvisor/', import.meta.url));
    await ctx.step('Check prerequisites', async () => {
      if (process.platform !== 'linux') throw new Error('This demo requires Linux');
      if (ctx.config.agent !== 'codex') throw new Error('This demo currently runs Codex only');
      const runtimes = await ctx.exec(['docker', 'info', '--format', '{{json .Runtimes}}']);
      if (!JSON.parse(runtimes.stdout).runsc) throw new Error('Configure the Docker runsc runtime first');
      await lstat(ctx.input.auth); // Never read or log credentials in the workflow.
    });

    const base = join(ctx.project, '.assembler', 'demos');
    await mkdir(base, { recursive: true });
    const artifacts = await mkdtemp(join(base, 'gvisor-'));
    const files = {
      workspace: join(artifacts, 'workspace'),
      checks: join(demo, 'checks'),
      codex: await realpath(ctx.input.codex),
      auth: await realpath(ctx.input.auth),
      certificates: await realpath(ctx.input.certificates),
    };
    const suffix = artifacts.split('gvisor-').at(-1)!.toLowerCase();
    const agent = new Sandbox(ctx, `assembler-agent-${suffix}`, artifacts);
    const verifier = new Sandbox(ctx, `assembler-verify-${suffix}`, artifacts);
    ctx.output('Artifacts', artifacts);
    let failure: unknown;
    try {
      await ctx.step('Prepare fresh project', () => cp(join(demo, 'fixture'), files.workspace, { recursive: true }));
      // Resolve the tag once; all containers in this run use the same image ID.
      await ctx.step('Pull toolchain', () => ctx.exec(['docker', 'pull', ctx.input.image]));
      const image = (await ctx.exec(['docker', 'image', 'inspect', '--format', '{{.Id}}', ctx.input.image])).stdout.trim();
      ctx.output('Image', image);
      await ctx.step('Start offline verifier', async () => {
        ctx.output('Isolation evidence', await verifier.start(image, files, false));
      });
      await ctx.step('Confirm original bug', async () => {
        const baseline = await verifier.exec(['node', '--test', '/checks/slugify.test.cjs'], { allowFailure: true });
        ctx.output('Baseline tests', baseline.stdout + baseline.stderr);
        if (baseline.exitCode !== 1 || !baseline.stdout.includes('ERR_ASSERTION')) {
          throw new Error('Expected assertion failures in the original fixture');
        }
      });
      await ctx.step('Start coding sandbox', () => agent.start(image, files, true));
      await ctx.step('Implement Markdown task', async () => {
        const prompt = await readFile(join(demo, 'prompts/implement.md'), 'utf8');
        ctx.output('Agent response', await agent.runPrompt(prompt));
      });
      // Freeze agent activity before independently checking its changes.
      await ctx.step('Stop coding sandbox', () => agent.remove());
      await ctx.step('Verify independently', async () => {
        const result = await verifier.exec(['node', '--test', '/checks/slugify.test.cjs']);
        ctx.output('Verified tests', result.stdout);
      });
      await ctx.step('Collect implementation', async () => {
        const path = join(files.workspace, 'slugify.cjs');
        const stat = await lstat(path);
        if (!stat.isFile() || stat.size > 64_000) throw new Error('Unexpected implementation artifact');
        ctx.output('Implementation', await readFile(path, 'utf8'));
      });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const cleanup = async () => {
        const results = await Promise.allSettled([agent.remove(), verifier.remove()]);
        const errors = results.filter(result => result.status === 'rejected');
        if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'Container cleanup failed');
      };
      try {
        if (ctx.signal.aborted) await cleanup();
        else await ctx.step('Remove containers', cleanup);
      } catch (error) {
        if (failure) ctx.output('Cleanup warning', String(error));
        else throw error;
      }
    }
  },
});
