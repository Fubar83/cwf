import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type Config } from "../src/config.ts";
import type { Issue } from "../src/jira.ts";
import { PLAN_HEADINGS } from "../src/prompts.ts";

const sh = (cmd: string, cwd?: string) =>
  execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export interface Sandbox {
  root: string;
  cfg: Config;
  origin: (repo: string) => string;
  ghLog: () => string[];
}

/**
 * Bygger en sandlåda: ett bart "origin"-repo per repo med standardbranch "develop",
 * en klonad main-checkout i projectsDir och ett låtsas-gh på PATH.
 */
export function sandbox(repos = ["api"], extra: Record<string, unknown> = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "cwf-test-"));
  const projects = join(root, "projects");
  mkdirSync(projects);
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.com";

  for (const repo of repos) {
    const seed = join(root, "seed", repo);
    mkdirSync(seed, { recursive: true });
    sh("git init -q -b develop", seed);
    writeFileSync(join(seed, "AGENTS.md"), "# Regler\n");
    writeFileSync(join(seed, "app.txt"), "v1\n");
    sh("git add -A && git commit -q -m init", seed);
    const bare = join(root, "origin", `${repo}.git`);
    sh(`git clone -q --bare ${seed} ${bare}`);
    sh(`git clone -q ${bare} ${join(projects, repo)}`);
  }

  // Låtsas-gh: loggar anrop och svarar på det cwf använder.
  const bin = join(root, "bin");
  mkdirSync(bin);
  const ghLogFile = join(root, "gh.log");
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
echo "$*" >> ${ghLogFile}
case "$1 $2" in
  "pr list") if [ -f ${root}/pr-created ]; then echo '[{"url":"https://github.com/acme/api/pull/7","number":7,"isDraft":true,"body":"x"}]'; else echo '[]'; fi ;;
  "pr create") touch ${root}/pr-created; echo "https://github.com/acme/api/pull/7" ;;
  "pr view") echo MERGED ;;
  *) ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;

  const cfg = ConfigSchema.parse({
    projectsDir: projects,
    jira: { site: "acme.atlassian.net", projects: [{ key: "vfs", repos }] },
    github: { org: "acme" },
    limits: { idleTimeoutMin: 1, waitForUserMin: 1 },
    repos: { defaults: { gate: [{ name: "innehåll", run: "test -s app.txt" }] } },
    ...extra,
  });
  return {
    root,
    cfg,
    origin: (repo) => join(root, "origin", `${repo}.git`),
    ghLog: () => {
      try {
        return readFileSync(ghLogFile, "utf8").trim().split("\n");
      } catch {
        return [];
      }
    },
  };
}

export const fakeIssue = (summary = "Lägg till CSV-export") => async (_: Config, key: string): Promise<Issue> => ({
  key,
  summary,
  raw: { key, summary, description: "Som användare vill jag…" },
  hash: `h-${summary}`,
});

export const validPlan = (extra = "") =>
  PLAN_HEADINGS.map((h) => `## ${h}\n\nInnehåll för ${h}. ${extra}`).join("\n\n");

export const question = (id = "q1") => ({
  id,
  question: "Ska exporten innehålla makulerade fakturor?",
  investigated: "Läste InvoiceService och ärendet.",
  options: [
    { label: "Ja", consequence: "Fler rader" },
    { label: "Nej", consequence: "Som rapporten idag" },
  ],
  recommendation: "Nej",
  why: "Matchar befintlig rapport.",
});

export { sh };
