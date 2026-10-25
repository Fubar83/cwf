import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { gitTry, run } from "./exec.ts";
import { Store } from "./state.ts";
import type { UI } from "./ui.ts";
import { isDirty, mainDir } from "./workspace.ts";

interface Candidate {
  slug: string;
  dir: string;
  reason: string;
  risky: string[];
  suggest: boolean;
}

async function prState(url: string, cwd: string): Promise<string | undefined> {
  const r = await run("gh", ["pr", "view", url, "--json", "state", "-q", ".state"], { cwd });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Finds issues to clean up. A merged PR is decided via gh, never via git (squash merges are invisible to git). */
export async function findCandidates(cfg: Config): Promise<Candidate[]> {
  if (!existsSync(cfg.projectsDir)) return [];
  const out: Candidate[] = [];
  for (const slug of readdirSync(cfg.projectsDir)) {
    const dir = join(cfg.projectsDir, slug);
    const store = Store.forIssue(dir);
    if (!store.exists()) continue;
    if (existsSync(store.path("lock"))) continue;
    const state = store.load();

    const risky: string[] = [];
    for (const repo of state.repos) {
      const wt = join(dir, repo);
      if (!existsSync(join(wt, ".git"))) continue;
      if (await isDirty(wt)) risky.push(`${repo}: uncommitted changes`);
      const ahead = await gitTry(wt, "rev-list", "--count", `origin/${state.branch}..HEAD`);
      if (ahead.code !== 0) {
        const any = await gitTry(wt, "log", "--oneline", "-1", "--branches", "--not", "--remotes");
        if (any.stdout.trim()) risky.push(`${repo}: commits that were never pushed`);
      } else if (Number(ahead.stdout.trim()) > 0) risky.push(`${repo}: ${ahead.stdout.trim()} unpushed commits`);
    }

    const urls = Object.entries(state.publish).filter(([, p]) => p.prUrl) as [string, { prUrl: string }][];
    if (urls.length) {
      const states = await Promise.all(urls.map(([repo, p]) => prState(p.prUrl, join(dir, repo))));
      if (states.every((s) => s === "MERGED" || s === "CLOSED")) {
        out.push({ slug, dir, reason: `PRs ${states.join("/").toLowerCase()}`, risky, suggest: risky.length === 0 });
      }
      continue;
    }
    const age = (Date.now() - statSync(store.path("state.json")).mtimeMs) / 86_400_000;
    if (age > cfg.clean.staleDays) {
      out.push({ slug, dir, reason: `no PR, untouched for ${Math.floor(age)} days`, risky, suggest: false });
    }
  }
  return out;
}

export async function removeIssue(cfg: Config, c: Candidate, force: boolean): Promise<void> {
  const store = Store.forIssue(c.dir);
  const state = store.load();
  const archive = join(cfg.projectsDir, ".cwf-archive", `${c.slug}-${new Date().toISOString().slice(0, 10)}`);
  mkdirSync(archive, { recursive: true });
  for (const f of ["state.json", "decisions.log", "usage.log", "plan"]) {
    if (existsSync(store.path(f))) cpSync(store.path(f), join(archive, f), { recursive: true });
  }
  for (const repo of state.repos) {
    const main = mainDir(cfg, repo);
    const wt = join(c.dir, repo);
    if (existsSync(wt)) {
      const r = await gitTry(main, "worktree", "remove", ...(force ? ["--force"] : []), wt);
      if (r.code !== 0) throw new Error(`Could not remove worktree ${wt}: ${r.stderr.trim()}`);
    }
    await gitTry(main, "branch", "-D", state.branch);
  }
  rmSync(c.dir, { recursive: true, force: true });
}

export async function clean(cfg: Config, ui: UI): Promise<number> {
  const list = await findCandidates(cfg);
  if (!list.length) {
    ui.info("Nothing to clean up.");
    return 0;
  }
  for (const c of list) {
    ui.heading(`${c.slug.toUpperCase()}: ${c.reason}`);
    for (const r of c.risky) ui.warn(r);
    const choices = c.risky.length
      ? [
          { value: "keep", label: "Keep" },
          { value: "force", label: "Remove anyway (the changes are lost)" },
        ]
      : c.suggest
        ? [
            { value: "remove", label: "Remove" },
            { value: "keep", label: "Keep" },
          ]
        : [
            { value: "keep", label: "Keep" },
            { value: "remove", label: "Remove" },
          ];
    const r = await ui.select("What do you want to do?", choices);
    if (r.kind !== "ok" || r.value === "keep") continue;
    await removeIssue(cfg, c, r.value === "force");
    ui.info("Removed and archived.");
  }
  return 0;
}
