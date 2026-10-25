import type { z } from "zod/v4";

/** Ett verktyg som wf ger Copilot. Argumenten valideras med zod innan handlern körs. */
export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.infer<S>) => Promise<ToolResult>;
}

export interface ToolResult {
  ok: boolean;
  /** Det Copilot får se. */
  text: string;
}

/** Ett anrop till ett inbyggt verktyg (skal, filskrivning m.m.) som policyn ska bedöma. */
export interface ToolCall {
  toolName: string;
  args: Record<string, unknown>;
  /** Behörighetstyp från SDK:ns permission request, när den finns. */
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
  /** Avgör varje inbyggt verktygsanrop innan det körs. */
  policy: (call: ToolCall) => PolicyDecision;
  /** Extra kontext till Copilot efter ett verktygsanrop (t.ex. varning om @ts-ignore). */
  afterTool?: (call: ToolCall) => string | undefined;
}

export interface AgentSession {
  /** Skickar ett meddelande. Löser när det är mottaget, inte när turen är klar. */
  send(prompt: string): Promise<void>;
  on(listener: (e: AgentEvent) => void): void;
  abort(): Promise<void>;
  /** Avslutar sessionen. Returnerar SDK:ns totalkostnad i nano-AIU om den finns. */
  close(): Promise<bigint | undefined>;
}

export interface Agent {
  createSession(spec: SessionSpec): Promise<AgentSession>;
  stop(): Promise<void>;
}

/** Skapar ett verktyg med argumenttyper från zod-schemat. */
export function defineTool<S extends z.ZodType>(t: ToolDef<S>): ToolDef {
  return t as unknown as ToolDef;
}

/** Validerar och kör ett verktyg. Fel returneras till Copilot så att den kan rätta sig. */
export async function invokeTool(tool: ToolDef, rawArgs: unknown): Promise<ToolResult> {
  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `- ${i.path.join(".") || "(rot)"}: ${i.message}`)
      .join("\n");
    return { ok: false, text: `Ogiltiga argument till ${tool.name}:\n${issues}\nRätta och anropa igen.` };
  }
  try {
    return await tool.handler(parsed.data);
  } catch (e) {
    return { ok: false, text: `${tool.name} misslyckades: ${(e as Error).message}` };
  }
}
