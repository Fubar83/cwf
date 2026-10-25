import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Agent, AgentEvent, AgentSession, SessionSpec, ToolResult } from "./types.ts";
import { invokeTool } from "./types.ts";

export class Aborted extends Error {}

/**
 * The shell for FakeAgent's shell commands. On Windows the default is cmd.exe, which does not
 * understand single quotes, so Git Bash (shipped with Git for Windows) is used instead.
 */
const posixShell = (): string | undefined => {
  if (process.platform !== "win32") return undefined;
  const [git] = execFileSync("where", ["git"], { encoding: "utf8" }).split(/\r?\n/);
  if (!git) throw new Error("Cannot find git on PATH, needed for shell commands in the tests.");
  // where may return ...\cmd\git.exe or ...\mingw64\bin\git.exe; the root is the Git installation.
  const root = git.trim().replace(/[\\/](cmd|mingw64[\\/]bin|bin)[\\/]git\.exe$/i, "");
  const bash = join(root, "bin", "bash.exe");
  if (!existsSync(bash)) throw new Error(`Cannot find Git Bash at ${bash}`);
  return bash;
};
export const SHELL = posixShell();

/** What a scripted fake agent can do, the way a model would. */
export interface FakeCtx {
  spec: SessionSpec;
  prompts: string[];
  call(tool: string, args: unknown): Promise<ToolResult>;
  /** Runs a shell command if the policy allows it. Returns null if it was denied. */
  shell(command: string): string | null;
  write(path: string, content: string): boolean;
  usage(inputTokens: number, outputTokens: number): void;
  /** Waits for the next message from cwf (e.g. a reminder). */
  nextPrompt(): Promise<string>;
}

export type FakeScript = (ctx: FakeCtx) => Promise<void>;

/**
 * Fake agent for tests. Each createSession takes the next script in the queue.
 * Used to run the whole flow without network and without cost.
 */
export class FakeAgent implements Agent {
  readonly denied: { tool: string; reason?: string }[] = [];
  readonly sessions: SessionSpec[] = [];
  constructor(private scripts: FakeScript[]) {}

  async createSession(spec: SessionSpec): Promise<AgentSession> {
    this.sessions.push(spec);
    const script = this.scripts.shift();
    if (!script) throw new Error("FakeAgent: no more scripts.");
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
        if (!tool) return { ok: false, text: `Unknown tool ${name}` };
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
        return execSync(command, { cwd: spec.cwd, encoding: "utf8", shell: SHELL, stdio: ["ignore", "pipe", "pipe"] });
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
