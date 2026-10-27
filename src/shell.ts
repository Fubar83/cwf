import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

let cached: string | undefined;

/**
 * The bash used for shell commands. On Windows a plain `bash` can resolve to the WSL launcher
 * in System32, which cannot see Windows paths, so Git Bash (shipped with Git for Windows) is used.
 */
export function bashPath(): string {
  if (process.platform !== "win32") return "bash";
  if (cached) return cached;
  const [git] = execFileSync("where", ["git"], { encoding: "utf8" }).split(/\r?\n/);
  if (!git) throw new Error("Cannot find git on PATH, which is needed for Git Bash on Windows.");
  // where may return ...\cmd\git.exe or ...\mingw64\bin\git.exe; the root is the Git installation.
  const root = git.trim().replace(/[\\/](cmd|mingw64[\\/]bin|bin)[\\/]git\.exe$/i, "");
  const bash = join(root, "bin", "bash.exe");
  if (!existsSync(bash)) throw new Error(`Cannot find Git Bash at ${bash}`);
  cached = bash;
  return bash;
}
