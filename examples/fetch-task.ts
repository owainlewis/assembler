import { defineWorkflow, z } from "../src/index.js";
import { jsonCommand } from "./lib/engineering.js";
import { fetchTicket, linearCommandsSchema } from "./lib/tickets.js";

// The same fetch step used by task-to-PR, runnable without changing code or GitHub.
export default defineWorkflow({ input: z.object({
  ticket: z.string().min(1), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  linearCommands: linearCommandsSchema,
}), async run(ctx) {
  const repo = ctx.input.repo ?? (await ctx.step("Resolve project", () => jsonCommand(ctx, ["gh", "repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
  await fetchTicket(ctx, ctx.input.ticket, repo, ctx.input.linearCommands);
} });
