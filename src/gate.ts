import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { rulesFor, type GateStep } from "./config.ts";
import { run } from "./exec.ts";
import { worktreeDir } from "./workspace.ts";

export interface StepResult {
  repo: string;
  name: string;
  ok: boolean;
  skipped?: boolean;
  output: string;
  fix?: string;
}

export interface GateResult {
  ok: boolean;
  steps: StepResult[];
}

/** gitleaks körs alltid sist, i alla repon, om det finns installerat. */
const SECRETS_STEP: GateStep = { name: "hemligheter (gitleaks)", run: "command -v gitleaks >/dev/null || exit 0; gitleaks git --no-banner --redact --log-opts=HEAD~20..HEAD 2>&1 || gitleaks detect --no-banner --redact 2>&1" };

const tail = (s: string, n = 4000) => (s.length > n ? `…(kortat)\n${s.slice(-n)}` : s);

/**
 * Kör repots kontroller i ordning och stannar vid första fel per repo.
 * Gate ändrar aldrig kod; `fix` skickas till Copilot som förslag.
 */
export async function runGate(cfg: Config, slug: string, repos: string[], timeoutMs = 20 * 60_000): Promise<GateResult> {
  const steps: StepResult[] = [];
  for (const repo of repos) {
    const cwd = worktreeDir(cfg, slug, repo);
    const rules = rulesFor(cfg, repo);
    for (const step of [...rules.gate, SECRETS_STEP]) {
      if (step.when && !existsSync(join(cwd, step.when))) {
        steps.push({ repo, name: step.name, ok: true, skipped: true, output: "" });
        continue;
      }
      const r = await run(step.run, [], { cwd, shell: true, timeoutMs });
      const ok = r.code === 0;
      steps.push({
        repo,
        name: step.name,
        ok,
        output: ok ? "" : tail(`${r.stdout}\n${r.stderr}`.trim()),
        fix: step.fix,
      });
      if (!ok) break;
    }
  }
  return { ok: steps.every((s) => s.ok), steps };
}

export function formatGate(g: GateResult): string {
  const lines = g.steps.map((s) => `${s.skipped ? "–" : s.ok ? "✓" : "✗"} ${s.repo}: ${s.name}${s.skipped ? " (hoppas över)" : ""}`);
  for (const s of g.steps.filter((s) => !s.ok)) {
    lines.push("", `## ${s.repo}: ${s.name} misslyckades`);
    if (s.fix) lines.push(`Förslag: kör \`${s.fix}\` i ${s.repo}.`);
    lines.push("```", s.output, "```");
  }
  return lines.join("\n");
}

/** Kör setup-kommandon (t.ex. dotnet restore) när en worktree skapats. */
export async function runSetup(cfg: Config, slug: string, repo: string): Promise<string | undefined> {
  const cwd = worktreeDir(cfg, slug, repo);
  for (const cmd of rulesFor(cfg, repo).setup) {
    const r = await run(cmd, [], { cwd, shell: true, timeoutMs: 20 * 60_000 });
    if (r.code !== 0) return `${repo}: "${cmd}" misslyckades:\n${tail(r.stderr || r.stdout, 2000)}`;
  }
  return undefined;
}
