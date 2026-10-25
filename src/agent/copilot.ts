/**
 * Adapter for @github/copilot-sdk. All SDK-specific code lives here, so the rest of
 * cwf can be tested with FakeAgent and a changed SDK only affects this file.
 *
 * The SDK is loaded dynamically and typed minimally. Fields and names to verify
 * against the locked version are marked VERIFY.
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
      throw new Error("Cannot find @github/copilot-sdk. Run pnpm install in the cwf repo.");
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
      toolName: String(input?.toolName ?? input?.kind ?? "unknown"),
      args: (input?.toolArgs ?? input ?? {}) as Record<string, unknown>,
      kind,
    });

    const session = await client.createSession({
      model: spec.model,
      workingDirectory: spec.cwd,
      streaming: true,
      systemMessage: { mode: "append", content: spec.systemPrompt },
      tools,
      // VERIFY: that customAgents may run a different model than the main session.
      customAgents: spec.researcherModel
        ? [{
            name: "researcher",
            description: "Reads code and documents and summarizes them. Never changes files.",
            model: spec.researcherModel,
            prompt: "Investigate what you are asked and answer briefly with file references. Never change files.",
          }]
        : undefined,
      hooks: {
        // The policy gate for built-in tools. cwf's own tools are always allowed.
        onPreToolUse: async (input: Any) => {
          emit({ type: "activity" });
          const call = toCall(input);
          if (spec.tools.some((t) => t.name === call.toolName)) return null;
          const d = spec.policy(call);
          return d.allow
            ? null
            : { permissionDecision: "deny", permissionDecisionReason: d.reason ?? "Denied by cwf." };
        },
        onPostToolUse: async (input: Any) => {
          emit({ type: "activity" });
          const extra = spec.afterTool?.(toCall(input));
          return extra ? { additionalContext: extra } : null;
        },
      },
      // YOLO mode: every permission request is approved, so an unattended run never stalls
      // waiting for a human. Built-in tool calls are still checked by onPreToolUse above,
      // which denies anything the policy rejects.
      onPermissionRequest: async () => ({ kind: "allow" }),
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
          emit({ type: "error", message: String(event.data?.message ?? "unknown error") });
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
          // VERIFY: experimental call, does it exist in the locked version?
          const m = await (session.rpc?.usage?.getMetrics ?? session.usage?.getMetrics)?.call(
            session.rpc?.usage ?? session.usage,
          );
          if (m?.totalNanoAiu != null) total = BigInt(Math.round(Number(m.totalNanoAiu)));
        } catch {
          /* the estimate from the usage events is good enough */
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
