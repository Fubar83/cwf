/**
 * Adapter mot @github/copilot-sdk. Allt SDK-specifikt ligger här, så att resten
 * av cwf går att testa med FakeAgent och så att en ändrad SDK bara påverkar den här filen.
 *
 * SDK:n laddas dynamiskt och typas minimalt. Fält och namn som ska verifieras mot
 * den låsta versionen i etapp 0 är märkta VERIFIERA.
 */
import { z } from "zod/v4";
import type { Agent, AgentEvent, AgentSession, SessionSpec, ToolCall } from "./types.ts";
import { invokeTool } from "./types.ts";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export class CopilotAgent implements Agent {
  private client: Any;

  private async ensureClient() {
    if (this.client) return this.client;
    let sdk: Any;
    try {
      sdk = await import("@github/copilot-sdk" as string);
    } catch {
      throw new Error("Hittar inte @github/copilot-sdk. Kör npm install i cwf-repot.");
    }
    this.client = new sdk.CopilotClient({ autoStart: false, autoRestart: false, logLevel: "error" });
    await this.client.start();
    return this.client;
  }

  async createSession(spec: SessionSpec): Promise<AgentSession> {
    const client = await this.ensureClient();
    const listeners: ((e: AgentEvent) => void)[] = [];
    const emit = (e: AgentEvent) => listeners.forEach((l) => l(e));

    const tools = spec.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema),
      handler: async (args: unknown) => {
        emit({ type: "activity" });
        const r = await invokeTool(t, args);
        emit({ type: "activity" });
        return { textResultForLlm: r.text, resultType: r.ok ? "success" : "failure" };
      },
    }));

    const toCall = (input: Any, kind?: string): ToolCall => ({
      toolName: String(input?.toolName ?? input?.kind ?? "okänt"),
      args: (input?.toolArgs ?? input ?? {}) as Record<string, unknown>,
      kind,
    });

    const session = await client.createSession({
      model: spec.model,
      workingDirectory: spec.cwd,
      streaming: true,
      systemMessage: { mode: "append", content: spec.systemPrompt },
      tools,
      // VERIFIERA: att customAgents får köra annan modell än huvudsessionen.
      customAgents: spec.researcherModel
        ? [{
            name: "researcher",
            description: "Läser kod och dokument och sammanfattar. Ändrar aldrig filer.",
            model: spec.researcherModel,
            prompt: "Undersök det du blir ombedd om och svara kort med filreferenser. Ändra aldrig filer.",
          }]
        : undefined,
      hooks: {
        onPreToolUse: async (input: Any) => {
          emit({ type: "activity" });
          const call = toCall(input);
          if (spec.tools.some((t) => t.name === call.toolName)) return null;
          const d = spec.policy(call);
          return d.allow
            ? null
            : { permissionDecision: "deny", permissionDecisionReason: d.reason ?? "Nekat av cwf." };
        },
        onPostToolUse: async (input: Any) => {
          emit({ type: "activity" });
          const extra = spec.afterTool?.(toCall(input));
          return extra ? { additionalContext: extra } : null;
        },
      },
      // Aldrig approveAll. Samma policy som hooken, som andra försvarslinje.
      // VERIFIERA: fältnamn i permission request (kind, fullCommandText, fileName, url).
      onPermissionRequest: async (req: Any) => {
        if (req?.kind === "custom-tool") return { kind: "allow" };
        const d = spec.policy({
          toolName: String(req?.toolName ?? req?.kind ?? "okänt"),
          args: {
            command: req?.fullCommandText ?? req?.command,
            path: req?.fileName ?? req?.path,
            url: req?.url,
            ...(typeof req === "object" ? req : {}),
          },
          kind: req?.kind,
        });
        return { kind: d.allow ? "allow" : "deny" };
      },
    });

    session.on((event: Any) => {
      switch (event?.type) {
        case "assistant.message":
          emit({ type: "message", text: String(event.data?.content ?? "") });
          break;
        case "assistant.usage":
          emit({
            type: "usage",
            model: String(event.data?.model ?? spec.model),
            inputTokens: Number(event.data?.inputTokens ?? 0),
            outputTokens: Number(event.data?.outputTokens ?? 0),
          });
          break;
        case "session.idle":
          emit({ type: "idle" });
          break;
        case "session.error":
          emit({ type: "error", message: String(event.data?.message ?? "okänt fel") });
          break;
        default:
          emit({ type: "activity" });
      }
    });

    return {
      send: async (prompt) => {
        await session.send({ prompt });
      },
      on: (l) => listeners.push(l),
      abort: async () => {
        await session.abort?.();
      },
      close: async () => {
        let total: bigint | undefined;
        try {
          // VERIFIERA: experimentellt anrop, finns det i den låsta versionen?
          const m = await (session.rpc?.usage?.getMetrics ?? session.usage?.getMetrics)?.call(
            session.rpc?.usage ?? session.usage,
          );
          if (m?.totalNanoAiu != null) total = BigInt(Math.round(Number(m.totalNanoAiu)));
        } catch {
          /* uppskattningen från usage-händelserna får räcka */
        }
        await (session.disconnect ?? session.destroy)?.call(session);
        return total;
      },
    };
  }

  async stop() {
    if (!this.client) return;
    const c = this.client;
    this.client = undefined;
    await Promise.race([
      c.stop(),
      new Promise((r) => setTimeout(r, 10_000)).then(() => c.forceStop?.()),
    ]);
  }
}
