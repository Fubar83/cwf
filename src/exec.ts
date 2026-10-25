import { spawn } from "node:child_process";

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
  /** Kör genom bash -lc (för gate- och setup-kommandon från inställningarna). */
  shell?: boolean;
}

/** Kör ett kommando utan att kasta vid fel. Returnerar alltid kod och utdata. */
export function run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const [file, argv] = opts.shell ? ["bash", ["-lc", [cmd, ...args].join(" ")]] : [cmd, args];
    const child = spawn(file, argv as string[], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
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
    super(`${command} misslyckades (kod ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
  }
}

/** Som run, men kastar CommandError vid felkod. */
export async function must(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new CommandError(`${cmd} ${args.join(" ")}`, r);
  return r.stdout;
}

export const git = (cwd: string, ...args: string[]) => must("git", args, { cwd });
export const gitTry = (cwd: string, ...args: string[]) => run("git", args, { cwd });
