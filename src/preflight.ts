import { existsSync, statfsSync, mkdirSync } from "node:fs";
import type { Config } from "./config.ts";
import { run } from "./exec.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const AWS_VARS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"];

/** Kontroller innan något händer. Allt körs, så att alla fel syns på en gång. */
export async function preflight(cfg: Config, opts: { allowHost: boolean }): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  const inContainer = existsSync("/.dockerenv") || process.env.WF_CONTAINER === "1";
  add("Kör i devcontainer", inContainer || opts.allowHost, inContainer ? undefined : "Starta i devcontainern, eller kör med --allow-host.");

  const awsSet = AWS_VARS.filter((v) => process.env[v]);
  const awsFiles = existsSync(`${process.env.HOME}/.aws/credentials`);
  add("Inga AWS-credentials", awsSet.length === 0 && !awsFiles,
    awsSet.length || awsFiles ? `Hittade ${[...awsSet, awsFiles ? "~/.aws/credentials" : ""].filter(Boolean).join(", ")}.` : undefined);

  for (const [tool, args] of [["git", ["--version"]], ["gh", ["--version"]], ["copilot", ["--version"]], ["twg", ["--version"]]] as const) {
    const r = await run(tool, [...args]);
    add(`${tool} finns`, r.code === 0, r.code === 0 ? r.stdout.split("\n")[0]?.trim() : `Hittar inte ${tool} på PATH.`);
  }

  const gh = await run("gh", ["auth", "status"]);
  add("Inloggad i gh", gh.code === 0, gh.code === 0 ? undefined : "Kör gh auth login.");

  const twg = await run("twg", ["doctor", "-o", "json"], { timeoutMs: 30_000 });
  add("Inloggad i twg", twg.code === 0, twg.code === 0 ? undefined : "Kör twg login.");

  try {
    mkdirSync(cfg.projectsDir, { recursive: true });
    const s = statfsSync(cfg.projectsDir);
    const freeGb = (s.bavail * s.bsize) / 1e9;
    add("Minst 2 GB ledigt", freeGb >= 2, `${freeGb.toFixed(1)} GB ledigt i ${cfg.projectsDir}`);
  } catch (e) {
    add("projectsDir går att skriva", false, String((e as Error).message));
  }

  return checks;
}
