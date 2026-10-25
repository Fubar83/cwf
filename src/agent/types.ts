import type { z } from "zod/v4";

/** A tool cwf gives Copilot. Arguments are validated with zod before the handler runs. */
export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.infer<S>) => Promise<ToolResult>;
}

export interface ToolResult {
  ok: boolean;
  /** What Copilot sees. */
  text: string;
}

/** A call to a built-in tool (shell, file write, ...) that the policy should judge. */
export interface ToolCall {
  toolName: string;
  args: Record<string, unknown>;
  /** Permission type from the SDK's permission request, when present. */
  kind?: "read" | "write" | "shell" | "url" | "mcp" | "custom-tool" | string;
}

export interface PolicyDecision {
  allow: boolean;
  reason?: string;
}

export type AgentEvent =
  | { type: "activity" }
  | { type: "message"; text: string }
  | { type: "idle" }
  | { type: "error"; message: string }
  | { type: "usage"; model: string; inputTokens: number; outputTokens: number };

export interface SessionSpec {
  model: string;
  researcherModel?: string;
  cwd: string;
  systemPrompt: string;
  tools: ToolDef[];
  /** Decides every built-in tool call before it runs. */
  policy: (call: ToolCall) => PolicyDecision;
  /** Extra context for Copilot after a tool call (e.g. a warning about @ts-ignore). */
  afterTool?: (call: ToolCall) => string | undefined;
}

export interface AgentSession {
  /** Sends a message. Resolves when it is received, not when the turn is done. */
  send(prompt: string): Promise<void>;
  on(listener: (e: AgentEvent) => void): void;
  abort(): Promise<void>;
  /** Ends the session. Returns the SDK's total cost in nano-AIU when available. */
  close(): Promise<bigint | undefined>;
}

export interface Agent {
  createSession(spec: SessionSpec): Promise<AgentSession>;
  stop(): Promise<void>;
}

/** Creates a tool with argument types taken from the zod schema. */
export function defineTool<S extends z.ZodType>(t: ToolDef<S>): ToolDef {
  return t as unknown as ToolDef;
}

/** Validates and runs a tool. Errors are returned to Copilot so it can correct itself. */
export async function invokeTool(tool: ToolDef, rawArgs: unknown): Promise<ToolResult> {
  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    return { ok: false, text: `Invalid arguments to ${tool.name}:\n${issues}\nFix them and call again.` };
  }
  try {
    return await tool.handler(parsed.data);
  } catch (e) {
    return { ok: false, text: `${tool.name} failed: ${(e as Error).message}` };
  }
}
