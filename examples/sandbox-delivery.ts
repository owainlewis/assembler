import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineWorkflow, z, WorkflowBlocked } from '../src/index.js';
import { jsonCommand } from '../src/engineering.js';
import { waitFeedback } from '../src/github.js';
import { Sandbox } from './gvisor/sandbox.js';
import { collectPatch, resolveRepository } from './gvisor/repository.js';
import { requireReady, deliveryResult } from './gvisor/delivery.js';
import { prepareGitHubToken } from './gvisor/credentials.js';

// One agent owns development. Code owns the environment and completion gate.
export default defineWorkflow({
  input: z.object({
    prompt: z.string().trim().min(1),
    repo: z.string().optional(),
    base: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).default('main'),
    branch: z.string().regex(/^assembler\/[a-z0-9][a-z0-9/-]*$/).optional(),
    image: z.string().default('node:22-bookworm'),
    codex: z.string().default(join(homedir(), '.local/bin/codex')),
    auth: z.string().default(join(homedir(), '.codex/auth.json')),
    gh: z.string().default('/usr/bin/gh'),
    githubToken: z.string().optional(),
    githubAuth: z.literal('gh').optional(),
    certificates: z.string().default('/etc/ssl/certs/ca-certificates.crt'),
    timeoutSeconds: z.number().int().min(1).max(1700).default(1200),
  }),
  async run(ctx) {
    const repository = await ctx.step('Resolve repository', () => resolveRepository(ctx, ctx.input.repo));
    const repo = repository.replace('https://github.com/', '').replace(/\.git$/, '');
    await ctx.step('Check prerequisites', async () => {
      if (process.platform !== 'linux' || ctx.config.agent !== 'codex') throw new Error('This workflow requires Linux and Codex');
      const runtimes = await jsonCommand(ctx, ['docker', 'info', '--format', '{{json .Runtimes}}']);
      if (!runtimes.runsc) throw new Error('Docker needs the runsc runtime');
      // Verification uses the host login, not an agent-authored success claim.
      await ctx.exec(['gh', 'repo', 'view', repo, '--json', 'nameWithOwner']);
    });
    const files = {
      workspace: '', codex: await realpath(ctx.input.codex), auth: await realpath(ctx.input.auth),
      certificates: await realpath(ctx.input.certificates),
      github: { cli: await realpath(ctx.input.gh), token: '' },
    };
    const directory = join(ctx.project, '.assembler', 'sandboxes');
    await mkdir(directory, { recursive: true });
    const artifacts = await mkdtemp(join(directory, 'delivery-'));
    const suffix = artifacts.split('delivery-').at(-1)!.toLowerCase();
    const slug = ctx.input.prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '') || 'task';
    const branch = ctx.input.branch ?? `assembler/${slug}-${suffix}`;
    files.workspace = join(artifacts, 'workspace');
    const sandbox = new Sandbox(ctx, `assembler-delivery-${suffix}`, artifacts);
    ctx.output('Artifacts', artifacts, { detail: true });
    let ready: unknown;
    let failure: unknown;
    let unchanged = false;
    let credentials: Awaited<ReturnType<typeof prepareGitHubToken>> | undefined;
    try {
      credentials = await ctx.step('Prepare GitHub credentials', () => prepareGitHubToken(ctx.input, ctx.signal));
      files.github.token = credentials.path;
      await mkdir(files.workspace);
      await ctx.step('Start gVisor sandbox', async () => {
        await ctx.exec(['docker', 'pull', ctx.input.image]);
        const image = (await ctx.exec(['docker', 'image', 'inspect', '--format', '{{.Id}}', ctx.input.image])).stdout.trim();
        ctx.output('Image', image, { detail: true });
        await sandbox.start(image, files, true);
      });
      let revision = '';
      await ctx.step('Fresh checkout and task branch', async () => {
        await sandbox.exec(['env', 'GIT_TERMINAL_PROMPT=0', 'git', 'clone', '--depth=1', '--single-branch', '--branch', ctx.input.base, '--', repository, '.']);
        revision = (await sandbox.exec(['git', 'rev-parse', 'HEAD'])).stdout.trim();
        // Never accidentally overwrite an existing task. Continuation is a separate flow.
        const existing = await sandbox.exec(['git', 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
        if (existing.stdout.trim()) throw new Error('Task branch already exists; continue its existing PR instead of starting a fresh delivery');
        await sandbox.exec(['git', 'switch', '-c', branch]);
        await sandbox.exec(['git', 'config', 'user.name', 'Assembler']);
        await sandbox.exec(['git', 'config', 'user.email', 'assembler@users.noreply.github.com']);
        ctx.output('Source', { repository, base: ctx.input.base, commit: revision, branch }, { detail: true });
      });
      const result = await ctx.step('Agent working', async () => {
        const instructions = await readFile(new URL('./gvisor/prompts/delivery.md', import.meta.url), 'utf8');
        const answer = await sandbox.runPrompt(`${instructions}\nRepository: ${repo}\nBase: ${ctx.input.base}\nTask branch: ${branch}\nTime budget: ${ctx.input.timeoutSeconds} seconds\n\nUser task:\n${ctx.input.prompt}`, ctx.input.timeoutSeconds, true, z.toJSONSchema(deliveryResult));
        try { return deliveryResult.parse(JSON.parse(answer)); }
        catch { throw new Error('Agent returned an invalid delivery result; inspect the agent log'); }
      });
      const head = (await sandbox.exec(['git', 'rev-parse', 'HEAD'])).stdout.trim();
      const dirty = (await sandbox.exec(['git', 'status', '--porcelain', '--untracked-files=all', '--ignored'])).stdout.trim();
      unchanged = head === revision && !dirty;
      if (result.status === 'blocked') throw new WorkflowBlocked(result.summary);
      ctx.output('Result', result.summary);
      if (result.status === 'no_changes') {
        if (!unchanged) throw new Error('Agent reported no changes but the checkout contains work; retained for inspection');
        return;
      }
      if ((await sandbox.exec(['git', 'branch', '--show-current'])).stdout.trim() !== branch ||
          (await sandbox.exec(['git', 'status', '--porcelain'])).stdout.trim()) throw new Error('Agent left a different branch or unpublished changes');
      await ctx.step('Export patch', () => collectPatch(sandbox, revision, join(artifacts, 'changes.patch')));
      // Stop all sandbox processes before independent remote verification.
      await ctx.step('Stop sandbox', () => sandbox.remove());
      ready = await ctx.step('Verify PR completion', async () => {
        const prs = await jsonCommand(ctx, ['gh', 'pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number,url,baseRefName,headRefOid,isCrossRepository']);
        if (prs.length !== 1 || prs[0].baseRefName !== ctx.input.base || prs[0].isCrossRepository || prs[0].headRefOid !== head)
          throw new Error('Expected one open PR for the exact task branch, base and local commit');
        const snapshot = await waitFeedback(ctx, repo, prs[0].number, { timeoutMs: 120_000, pollMs: 10_000, quietMs: 20_000 });
        requireReady(snapshot, head);
        return { pr: prs[0].url, head, checks: 'passed', merged: false };
      });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await sandbox.remove(); // Fresh cancellation signal, also after Ctrl-C.
        if (ready || unchanged) {
          await rm(files.workspace, { recursive: true, force: true });
          ctx.output('Cleanup', unchanged ? 'Sandbox and unchanged checkout removed. No code changes.' : 'Sandbox and checkout removed; patch and logs retained.');
        } else {
          ctx.output('Recovery', `Container removed. Checkout retained for inspection:\n${files.workspace}`);
        }
      } catch (error) {
        ctx.output('Cleanup warning', { container: sandbox.name, workspace: files.workspace, error: String(error) });
        if (!failure) throw error;
      } finally { await credentials?.cleanup(); }
    }
    ctx.output('Ready', ready, { detail: true });
    ctx.output('Pull request', (ready as { pr: string }).pr);
  },
});
