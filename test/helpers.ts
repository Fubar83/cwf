import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { SHELL } from "../src/agent/fake.ts";
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
 * Builds a sandbox: one bare "origin" repo per repo with default branch "develop",
 * a cloned main checkout in projectsDir and a fake gh on PATH.
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
    writeFileSync(join(seed, "AGENTS.md"), "# Rules\n");
    writeFileSync(join(seed, "app.txt"), "v1\n");
    sh("git add -A && git commit -q -m init", seed);
    const bare = join(root, "origin", `${repo}.git`);
    sh(`git clone -q --bare ${seed} ${bare}`);
    sh(`git clone -q ${bare} ${join(projects, repo)}`);
  }

  // Fake gh: logs every call and answers the calls cwf makes.
  // On Windows it is also written as gh.cmd, since spawn can only start .cmd shims through cmd.exe.
  const bin = join(root, "bin");
  mkdirSync(bin);
  const ghLogFile = join(root, "gh.log").replaceAll("\\", "/");
  const ghRoot = root.replaceAll("\\", "/");
  const ghScript = join(bin, "gh");
  writeFileSync(
    ghScript,
    `#!/usr/bin/env bash
echo "$*" >> ${ghLogFile}
case "$1 $2" in
  "pr list") if [ -f ${ghRoot}/pr-created ]; then echo '[{"url":"https://github.com/acme/api/pull/7","number":7,"isDraft":true,"body":"x"}]'; else echo '[]'; fi ;;
  "pr create") touch ${ghRoot}/pr-created; echo "https://github.com/acme/api/pull/7" ;;
  "pr view") echo MERGED ;;
  *) ;;
esac
`,
  );
  chmodSync(ghScript, 0o755);
  if (process.platform === "win32") {
    writeFileSync(join(bin, "gh.cmd"), `@"${SHELL}" "${ghScript.replaceAll("\\", "/")}" %*\r\n`);
  }
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;

  const cfg = ConfigSchema.parse({
    projectsDir: projects,
    jira: { site: "acme.atlassian.net", projects: [{ key: "vfs", repos }] },
    github: { org: "acme" },
    limits: { idleTimeoutMin: 1, waitForUserMin: 1 },
    repos: { defaults: { gate: [{ name: "content", run: "test -s app.txt" }] } },
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

export const fakeIssue = (summary = "Add CSV export") => async (_: Config, key: string): Promise<Issue> => ({
  key,
  summary,
  raw: { key, summary, description: "As a user I want…" },
  hash: `h-${summary}`,
});

export const validPlan = (extra = "") =>
  PLAN_HEADINGS.map((h) => `## ${h}\n\nContent for ${h}. ${extra}`).join("\n\n");

export const question = (id = "q1") => ({
  id,
  question: "Should the export include voided invoices?",
  investigated: "Read InvoiceService and the issue.",
  options: [
    { label: "Yes", consequence: "More rows" },
    { label: "No", consequence: "Same as the report today" },
  ],
  recommendation: "No",
  why: "Matches the existing report.",
});

export { sh };
