import { statfsSync, mkdirSync } from "node:fs";
import type { Config } from "./config.ts";
import { run } from "./exec.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Checks before anything happens. Everything runs, so that all failures show at once. */
export async function preflight(cfg: Config): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  for (const [tool, args] of [["git", ["--version"]], ["gh", ["--version"]], ["copilot", ["--version"]], ["twg", ["--version"]]] as const) {
    const r = await run(tool, [...args]);
    add(`${tool} found`, r.code === 0, r.code === 0 ? r.stdout.split("\n")[0]?.trim() : `Cannot find ${tool} on PATH.`);
  }

  const gh = await run("gh", ["auth", "status"]);
  add("Logged in to gh", gh.code === 0, gh.code === 0 ? undefined : "Run gh auth login.");

  const twg = await run("twg", ["doctor", "-o", "json"], { timeoutMs: 30_000 });
  add("Logged in to twg", twg.code === 0, twg.code === 0 ? undefined : "Run twg login.");

  try {
    mkdirSync(cfg.projectsDir, { recursive: true });
    const s = statfsSync(cfg.projectsDir);
    const freeGb = (s.bavail * s.bsize) / 1e9;
    add("At least 2 GB free", freeGb >= 2, `${freeGb.toFixed(1)} GB free in ${cfg.projectsDir}`);
  } catch (e) {
    add("projectsDir is writable", false, String((e as Error).message));
  }

  return checks;
}
