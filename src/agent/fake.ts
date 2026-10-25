import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Agent, AgentEvent, AgentSession, SessionSpec, ToolResult } from "./types.ts";
import { invokeTool } from "./types.ts";

export class Aborted extends Error {}

/** Det ett skript i FakeAgent kan göra, som en modell skulle. */
export interface FakeCtx {
  spec: SessionSpec;
  prompts: string[];
  call(tool: string, args: unknown): Promise<ToolResult>;
  /** Kör ett skalkommando om policyn tillåter. Returnerar null om det nekades. */
  shell(command: string): string | null;
  write(path: string, content: string): boolean;
  usage(inputTokens: number, outputTokens: number): void;
  /** Väntar på nästa meddelande från cwf (t.ex. en påminnelse). */
  nextPrompt(): Promise<string>;
}

export type FakeScript = (ctx: FakeCtx) => Promise<void>;

/**
 * Låtsasagent för tester. Varje createSession tar nästa skript i kön.
 * Används för att köra hela flödet utan nätverk och utan kostnad.
 */
export class FakeAgent implements Agent {
  readonly denied: { tool: string; reason?: string }[] = [];
  readonly sessions: SessionSpec[] = [];
  constructor(private scripts: FakeScript[]) {}

  async createSession(spec: SessionSpec): Promise<AgentSession> {
    this.sessions.push(spec);
    const script = this.scripts.shift();
    if (!script) throw new Error("FakeAgent: inga fler skript.");
    const listeners: ((e: AgentEvent) => void)[] = [];
    const emit = (e: AgentEvent) => queueMicrotask(() => listeners.forEach((l) => l(e)));
    let aborted = false;
    const inbox: string[] = [];
    let waiter: ((p: string) => void) | undefined;
    let started = false;
    let finished = false;

    const guard = () => {
      if (aborted) throw new Aborted();
    };

    const ctx: FakeCtx = {
      spec,
      prompts: [],
      call: async (name, args) => {
        guard();
        const tool = spec.tools.find((t) => t.name === name);
        if (!tool) return { ok: false, text: `Okänt verktyg ${name}` };
        emit({ type: "activity" });
        const r = await invokeTool(tool, args);
        guard();
        return r;
      },
      shell: (command) => {
        guard();
        const d = spec.policy({ toolName: "bash", args: { command }, kind: "shell" });
        if (!d.allow) {
          this.denied.push({ tool: command, reason: d.reason });
          return null;
        }
        emit({ type: "activity" });
        return execSync(command, { cwd: spec.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      },
      write: (path, content) => {
        guard();
        const abs = resolve(spec.cwd, path);
        const d = spec.policy({ toolName: "create", args: { path: abs }, kind: "write" });
        if (!d.allow) {
          this.denied.push({ tool: `write ${path}`, reason: d.reason });
          return false;
        }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
        return true;
      },
      usage: (inputTokens, outputTokens) =>
        emit({ type: "usage", model: spec.model, inputTokens, outputTokens }),
      nextPrompt: () =>
        new Promise((res) => {
          const p = inbox.shift();
          if (p !== undefined) res(p);
          else waiter = res;
        }),
    };

    return {
      send: async (prompt) => {
        ctx.prompts.push(prompt);
        if (!started) {
          started = true;
          script(ctx)
            .catch((e) => {
              if (!(e instanceof Aborted)) emit({ type: "error", message: String(e?.message ?? e) });
            })
            .finally(() => {
              finished = true;
              if (!aborted) emit({ type: "idle" });
            });
        } else if (finished) {
          emit({ type: "idle" });
        } else if (waiter) {
          const w = waiter;
          waiter = undefined;
          w(prompt);
        } else inbox.push(prompt);
      },
      on: (l) => listeners.push(l),
      abort: async () => {
        aborted = true;
      },
      close: async () => {
        aborted = true;
        return undefined;
      },
    };
  }

  async stop() {}
}
