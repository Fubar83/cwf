#!/usr/bin/env node
// wt – one command for feature worktrees.
//
//   wt                          list all features
//   wt <feature>                list the worktrees of a feature
//   wt <feature> <repo>         create the worktree if missing, then print its path
//   wt <feature> <repo> --rm    remove that worktree (--force discards uncommitted changes)
//
// Only the path goes to stdout, so `cd "$(wt feature-a repo1)"` works. Messages go to stderr.
// Layout: <projects>/<repo> is the main checkout, <projects>/<feature>/<repo>-<feature> the worktree.
// <projects> is $WT_PROJECTS, default ~/projects. Uses git only; never copies a repo.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const projects = process.env.WT_PROJECTS ?? join(homedir(), "projects");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitOk(cwd, ...args) {
  try {
    git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

function die(msg) {
  console.error(`wt: ${msg}`);
  process.exit(1);
}

const info = (msg) => console.error(msg);
const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
const worktreeOf = (feature, repo) => join(projects, feature, `${repo}-${feature}`);
const hasWorktree = (feature, repo) => existsSync(join(worktreeOf(feature, repo), ".git"));

function mainCheckout(repo) {
  const dir = join(projects, repo);
  if (!existsSync(join(dir, ".git"))) die(`${repo} is not a git repository in ${projects}`);
  return dir;
}

/** Where a new branch starts: origin's default branch if known, otherwise the main checkout's HEAD. */
function baseRef(main) {
  if (gitOk(main, "fetch", "--quiet", "origin") && gitOk(main, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD")) {
    return "origin/HEAD";
  }
  return "HEAD";
}

function create(feature, repo) {
  const main = mainCheckout(repo);
  const wt = worktreeOf(feature, repo);
  if (existsSync(wt)) die(`${wt} exists but is not a worktree. Remove it by hand.`);

  const branchExists = gitOk(main, "rev-parse", "--verify", "--quiet", `refs/heads/${feature}`);
  if (git(main, "worktree", "list", "--porcelain").split("\n").includes(`branch refs/heads/${feature}`)) {
    die(`branch ${feature} is already checked out in another worktree of ${repo}`);
  }

  mkdirSync(join(projects, feature), { recursive: true });
  try {
    if (branchExists) git(main, "worktree", "add", wt, feature);
    else git(main, "worktree", "add", "-b", feature, wt, baseRef(main));
  } catch (e) {
    // Leave nothing behind if git refused.
    if (!existsSync(wt)) rmSync(join(projects, feature), { recursive: true, force: true });
    die(`git worktree add failed:\n${e.stderr ?? e.message}`);
  }
  info(`Created ${repo}-${feature} on branch ${feature}.`);
  return wt;
}

function remove(feature, repo, force) {
  if (!hasWorktree(feature, repo)) die(`no worktree for ${repo} in ${feature}`);
  const main = mainCheckout(repo);
  const wt = worktreeOf(feature, repo);
  if (!force && git(wt, "status", "--porcelain").length > 0) {
    die(`${wt} has uncommitted changes. Commit them, or add --force to discard them.`);
  }
  try {
    git(main, "worktree", "remove", ...(force ? ["--force"] : []), wt);
  } catch (e) {
    die(`git worktree remove failed:\n${e.stderr ?? e.message}`);
  }
  const fdir = join(projects, feature);
  if (readdirSync(fdir).length === 0) rmSync(fdir, { recursive: true });
  info(`Removed ${wt}. Branch ${feature} in ${repo} was kept.`);
}

/** Worktrees of one feature, or of all features when feature is undefined. */
function list(feature) {
  if (!isDir(projects)) die(`${projects} does not exist`);
  const features = feature ? [feature] : readdirSync(projects).filter((f) => isDir(join(projects, f)) && !f.startsWith("."));
  let shown = false;
  for (const f of features.sort()) {
    const fdir = join(projects, f);
    if (!isDir(fdir)) continue;
    // A feature directory holds worktrees named <repo>-<feature>.
    const entries = readdirSync(fdir).filter((e) => e.endsWith(`-${f}`) && existsSync(join(fdir, e, ".git")));
    if (!entries.length) continue;
    shown = true;
    console.log(f);
    for (const e of entries) console.log(`  ${e.slice(0, -(f.length + 1)).padEnd(20)} ${join(fdir, e)}`);
  }
  if (!shown) console.log(feature ? `No worktrees for ${feature}.` : "No features yet. Create one with: wt <feature> <repo>");
}

const args = process.argv.slice(2);
const rm = args.includes("--rm");
const force = args.includes("--force");
const [feature, repo, extra] = args.filter((a) => !a.startsWith("--"));

if (extra !== undefined || (args.some((a) => a.startsWith("--")) && !rm && !force) || (rm && !repo) || (force && !rm)) {
  console.error(`Usage:
  wt                          list all features
  wt <feature>                list the worktrees of a feature
  wt <feature> <repo>         create the worktree if missing, then print its path
  wt <feature> <repo> --rm    remove it (add --force to discard uncommitted changes)`);
  process.exit(1);
}

if (!feature) list(undefined);
else if (!repo) list(feature);
else if (rm) remove(feature, repo, force);
else {
  const wt = hasWorktree(feature, repo) ? worktreeOf(feature, repo) : create(feature, repo);
  console.log(wt);
}
