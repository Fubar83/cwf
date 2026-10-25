import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { git, gitTry, must } from "./exec.ts";

/** "Lägg till CSV-export för fakturor" → "lagg-till-csv-export-for-fakturor" (max 40 tecken). */
export function slugify(title: string, max = 40): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, max).replace(/-+$/, "") || "arende";
}

export function branchName(slug: string, title: string) {
  return `${slug}-${slugify(title)}`;
}

export const mainDir = (cfg: Config, repo: string) => join(cfg.projectsDir, repo);
export const issueDir = (cfg: Config, slug: string) => join(cfg.projectsDir, slug);
export const worktreeDir = (cfg: Config, slug: string, repo: string) => join(issueDir(cfg, slug), repo);

/** Klonar repot om main-checkouten saknas. Använder gh så att SSO och org stämmer. */
export async function ensureMainCheckout(cfg: Config, repo: string): Promise<string> {
  const dir = mainDir(cfg, repo);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(cfg.projectsDir, { recursive: true });
    await must("gh", ["repo", "clone", `${cfg.github.org}/${repo}`, dir]);
  }
  return dir;
}

/** Standardbranchen enligt remoten. Antas aldrig vara "main". */
export async function defaultBranch(repoDir: string): Promise<string> {
  const r = await gitTry(repoDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (r.code === 0) return r.stdout.trim().replace(/^origin\//, "");
  await gitTry(repoDir, "remote", "set-head", "origin", "--auto");
  const again = await gitTry(repoDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (again.code === 0) return again.stdout.trim().replace(/^origin\//, "");
  throw new Error(`Kunde inte avgöra standardbranch för ${repoDir}.`);
}

async function branchExists(dir: string, ref: string) {
  return (await gitTry(dir, "rev-parse", "--verify", "--quiet", ref)).code === 0;
}

/**
 * Skapar eller återanvänder ärendets worktree för ett repo.
 * Finns branchen på remoten (t.ex. från en annan dator) byggs den vidare på.
 */
export async function ensureWorktree(cfg: Config, slug: string, repo: string, branch: string): Promise<string> {
  const main = await ensureMainCheckout(cfg, repo);
  const wt = worktreeDir(cfg, slug, repo);
  await git(main, "fetch", "--prune", "origin");
  await gitTry(main, "worktree", "prune");

  if (existsSync(join(wt, ".git"))) {
    const current = (await git(wt, "branch", "--show-current")).trim();
    if (current !== branch) {
      throw new Error(`${wt} är utcheckad på "${current}", väntade "${branch}". Rätta till det manuellt.`);
    }
    return wt;
  }

  const base = await defaultBranch(main);
  if (await branchExists(main, `refs/heads/${branch}`)) {
    await git(main, "worktree", "add", wt, branch);
  } else if (await branchExists(main, `refs/remotes/origin/${branch}`)) {
    await git(main, "worktree", "add", "--track", "-b", branch, wt, `origin/${branch}`);
  } else {
    await git(main, "worktree", "add", "--no-track", "-b", branch, wt, `origin/${base}`);
  }
  return wt;
}

export async function isDirty(wt: string): Promise<boolean> {
  return (await git(wt, "status", "--porcelain")).trim().length > 0;
}

export type MergeResult = "up-to-date" | "merged" | "conflict" | "skipped-dirty";

/** Mergar in standardbranchen. Aldrig rebase. Konflikter lämnas åt nästa Bygga-varv. */
export async function mergeDefault(wt: string): Promise<MergeResult> {
  if (await isDirty(wt)) return "skipped-dirty";
  await git(wt, "fetch", "origin");
  const base = await defaultBranch(wt);
  const before = (await git(wt, "rev-parse", "HEAD")).trim();
  const r = await gitTry(wt, "merge", "--no-edit", `origin/${base}`);
  if (r.code !== 0) {
    const conflicts = (await git(wt, "diff", "--name-only", "--diff-filter=U")).trim();
    if (conflicts) return "conflict";
    throw new Error(`git merge misslyckades i ${wt}: ${r.stderr.trim()}`);
  }
  const after = (await git(wt, "rev-parse", "HEAD")).trim();
  return before === after ? "up-to-date" : "merged";
}

/** Commits på branchen som inte finns i standardbranchen. */
export async function commitsAhead(wt: string): Promise<number> {
  const base = await defaultBranch(wt);
  return Number((await git(wt, "rev-list", "--count", `origin/${base}..HEAD`)).trim());
}

/** Kontrollerar att ingen redan pushad commit har skrivits om (amend/rebase efter push). */
export async function remoteIsAncestor(wt: string, branch: string): Promise<boolean> {
  if (!(await branchExists(wt, `refs/remotes/origin/${branch}`))) return true;
  return (await gitTry(wt, "merge-base", "--is-ancestor", `origin/${branch}`, "HEAD")).code === 0;
}
