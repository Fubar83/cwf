import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { git, gitTry, must } from "./exec.ts";

/** "Add CSV export for invoices" → "add-csv-export-for-invoices" (max 40 characters). */
export function slugify(title: string, max = 40): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, max).replace(/-+$/, "") || "issue";
}

export function branchName(slug: string, title: string) {
  return `${slug}-${slugify(title)}`;
}

export const mainDir = (cfg: Config, repo: string) => join(cfg.projectsDir, repo);
export const issueDir = (cfg: Config, slug: string) => join(cfg.projectsDir, slug);
export const worktreeDir = (cfg: Config, slug: string, repo: string) => join(issueDir(cfg, slug), repo);

/** Clones the repo if the main checkout is missing. Uses gh so that SSO and the org match. */
export async function ensureMainCheckout(cfg: Config, repo: string): Promise<string> {
  const dir = mainDir(cfg, repo);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(cfg.projectsDir, { recursive: true });
    await must("gh", ["repo", "clone", `${cfg.github.org}/${repo}`, dir]);
  }
  return dir;
}

/** The default branch according to the remote. Never assumed to be "main". */
export async function defaultBranch(repoDir: string): Promise<string> {
  const r = await gitTry(repoDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (r.code === 0) return r.stdout.trim().replace(/^origin\//, "");
  await gitTry(repoDir, "remote", "set-head", "origin", "--auto");
  const again = await gitTry(repoDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (again.code === 0) return again.stdout.trim().replace(/^origin\//, "");
  throw new Error(`Could not determine the default branch for ${repoDir}.`);
}

async function branchExists(dir: string, ref: string) {
  return (await gitTry(dir, "rev-parse", "--verify", "--quiet", ref)).code === 0;
}

/**
 * Creates or reuses the issue's worktree for a repo.
 * If the branch exists on the remote (e.g. from another machine), it is built upon.
 */
export async function ensureWorktree(cfg: Config, slug: string, repo: string, branch: string): Promise<string> {
  const main = await ensureMainCheckout(cfg, repo);
  const wt = worktreeDir(cfg, slug, repo);
  await git(main, "fetch", "--prune", "origin");
  await gitTry(main, "worktree", "prune");

  if (existsSync(join(wt, ".git"))) {
    const current = (await git(wt, "branch", "--show-current")).trim();
    if (current !== branch) {
      throw new Error(`${wt} is checked out on "${current}", expected "${branch}". Fix it manually.`);
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

/** Merges in the default branch. Never rebase. Conflicts are left for the next build round. */
export async function mergeDefault(wt: string): Promise<MergeResult> {
  if (await isDirty(wt)) return "skipped-dirty";
  await git(wt, "fetch", "origin");
  const base = await defaultBranch(wt);
  const before = (await git(wt, "rev-parse", "HEAD")).trim();
  const r = await gitTry(wt, "merge", "--no-edit", `origin/${base}`);
  if (r.code !== 0) {
    const conflicts = (await git(wt, "diff", "--name-only", "--diff-filter=U")).trim();
    if (conflicts) return "conflict";
    throw new Error(`git merge failed in ${wt}: ${r.stderr.trim()}`);
  }
  const after = (await git(wt, "rev-parse", "HEAD")).trim();
  return before === after ? "up-to-date" : "merged";
}

/** Commits on the branch that are not in the default branch. */
export async function commitsAhead(wt: string): Promise<number> {
  const base = await defaultBranch(wt);
  return Number((await git(wt, "rev-list", "--count", `origin/${base}..HEAD`)).trim());
}

/** Checks that no already pushed commit has been rewritten (amend/rebase after push). */
export async function remoteIsAncestor(wt: string, branch: string): Promise<boolean> {
  if (!(await branchExists(wt, `refs/remotes/origin/${branch}`))) return true;
  return (await gitTry(wt, "merge-base", "--is-ancestor", `origin/${branch}`, "HEAD")).code === 0;
}
