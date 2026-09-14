export interface AgentResult {
  text: string;
  data?: unknown;
  sessionId?: string;
  usage?: { input: number; cachedInput: number; output: number };
  commands?: { command: string; exitCode: number }[];
}
export interface AgentRequest {
  prompt: string; cwd: string; model?: string; executable?: string;
  readOnly?: boolean; schema?: Record<string, unknown>; signal: AbortSignal;
  readCommands?: string[];
  event: (event: unknown) => void;
}

export function readCommandDecision(commands: string[], command: unknown): "allow" | "deny" {
  return typeof command === "string" && commands.includes(command.trim()) ? "allow" : "deny";
}

export async function runSDK(provider: "codex" | "claude", request: AgentRequest): Promise<AgentResult> {
  if (provider === "codex") {
    const { Codex } = await import("@openai/codex-sdk");
    const sdk = new Codex({ codexPathOverride: request.executable, ...(request.readCommands ? { config: {
      default_permissions: "assembler-read-cli",
      permissions: { "assembler-read-cli": { extends: ":read-only", network: { enabled: true } } },
      features: { apps: false, multi_agent: false },
    } } : {}) });
    const thread = sdk.startThread({ workingDirectory: request.cwd, model: request.model,
      ...(request.readCommands ? { webSearchMode: "disabled" as const } : { sandboxMode: request.readOnly ? "read-only" as const : "workspace-write" as const }), approvalPolicy: "never" });
    const { events } = await thread.runStreamed(request.prompt, { outputSchema: request.schema, signal: request.signal });
    let text = "", completed = false;
    let usage: AgentResult["usage"];
    const commands: NonNullable<AgentResult["commands"]> = [];
    let failure: Error | undefined;
    try { for await (const event of events) {
      request.event(event);
      // Drain the SDK iterator before throwing so its subprocess is cleaned up.
      if (event.type === "error") failure = new Error(event.message);
      if (event.type === "turn.failed") failure = new Error(event.error.message);
      if (event.type === "item.completed" && event.item.type === "agent_message") text = event.item.text;
      if (event.type === "item.completed" && event.item.type === "command_execution") commands.push({ command: event.item.command, exitCode: event.item.exit_code ?? 1 });
      if (event.type === "turn.completed") {
        completed = true;
        usage = { input: event.usage.input_tokens, cachedInput: event.usage.cached_input_tokens, output: event.usage.output_tokens };
      }
    } } catch (error) { throw failure ?? error; }
    if (failure) throw failure;
    if (!completed) throw new Error("Codex ended without completing its turn");
    return { text, data: request.schema ? JSON.parse(text) : undefined, sessionId: thread.id ?? undefined, usage, commands };
  }
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const response = query({ prompt: request.prompt, options: {
    cwd: request.cwd, model: request.model, pathToClaudeCodeExecutable: request.executable,
    abortController: controller, settingSources: ["user", "project", "local"],
    permissionMode: request.readOnly ? "dontAsk" : "acceptEdits",
    ...(request.readCommands ? { tools: ["Bash"], strictMcpConfig: true, mcpServers: {}, hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [async input => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const command = (input.tool_input as { command?: unknown }).command;
        return { hookSpecificOutput: { hookEventName: "PreToolUse" as const,
          permissionDecision: readCommandDecision(request.readCommands!, command),
          permissionDecisionReason: "Only the workflow's exact read commands are permitted in this step." } };
      }] }],
    } } : request.readOnly ? { tools: ["Read", "Glob", "Grep"], allowedTools: ["Read", "Glob", "Grep"] } : {}),
    ...(request.schema ? { outputFormat: { type: "json_schema", schema: request.schema } as const } : {}),
  } });
  const calls = new Map<string, string>();
  const commands: NonNullable<AgentResult["commands"]> = [];
  try {
    for await (const event of response) {
      request.event(event);
      if (event.type === "assistant") for (const block of event.message.content) {
        if (block.type === "tool_use" && block.name === "Bash") calls.set(block.id, String((block.input as { command?: string }).command ?? ""));
      }
      if (event.type === "user" && Array.isArray(event.message.content)) for (const block of event.message.content) {
        if (block.type === "tool_result" && calls.has(block.tool_use_id)) {
          commands.push({ command: calls.get(block.tool_use_id)!, exitCode: block.is_error ? 1 : 0 });
          calls.delete(block.tool_use_id);
        }
      }
      if (event.type !== "result") continue;
      if (event.subtype !== "success" || event.is_error) throw new Error(`Claude failed: ${event.subtype}`);
      return { text: event.result, data: event.structured_output, sessionId: event.session_id, commands,
        usage: { input: event.usage.input_tokens + (event.usage.cache_read_input_tokens ?? 0) + (event.usage.cache_creation_input_tokens ?? 0),
          cachedInput: event.usage.cache_read_input_tokens ?? 0, output: event.usage.output_tokens } };
    }
    throw new Error("Claude ended without a result");
  } finally { request.signal.removeEventListener("abort", abort); response.close(); }
}
