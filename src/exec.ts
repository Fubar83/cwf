import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  /** Runs through bash -lc (for gate and setup commands from the config). */
  shell?: boolean;
}

/**
 * Finds a command on PATH the way cmd.exe does (PATHEXT on Windows).
 * Returns the full path, or undefined if it is not found.
 */
function findOnPath(cmd: string): string | undefined {
  const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of [...exts, ""]) {
      const p = join(dir, cmd + ext);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/**
 * On Windows, spawn cannot run .cmd or .bat files directly (npm installs tools such as
 * copilot and twg that way). Those are started through cmd.exe instead.
 */
function resolveCommand(cmd: string, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform !== "win32" || /[\\/]/.test(cmd)) return { file: cmd, args, verbatim: false };
  const found = findOnPath(cmd);
  if (!found || !/\.(cmd|bat)$/i.test(found)) return { file: found ?? cmd, args, verbatim: false };
  const quote = (a: string) => `"${a.replace(/"/g, '\\"')}"`;
  return {
    file: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${[found, ...args].map(quote).join(" ")}"`],
    verbatim: true,
  };
}

/** Runs a command without throwing on failure. Always returns the exit code and output. */
export function run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const call = opts.shell
      ? { file: "bash", args: ["-lc", [cmd, ...args].join(" ")], verbatim: false }
      : resolveCommand(cmd, args);
    const child = spawn(call.file, call.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: call.verbatim,
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
    }
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err.message) });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? (signal ? 124 : 1), stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly result: ExecResult,
  ) {
    super(`${command} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
  }
}

/** Like run, but throws CommandError on a non-zero exit code. */
export async function must(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new CommandError(`${cmd} ${args.join(" ")}`, r);
  return r.stdout;
}

export const git = (cwd: string, ...args: string[]) => must("git", args, { cwd });
export const gitTry = (cwd: string, ...args: string[]) => run("git", args, { cwd });
