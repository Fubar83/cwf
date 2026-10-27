#!/usr/bin/env node
// wt – feature worktrees for one repo at a time.
//
//   wt create <feature> <repo>     git worktree for <repo> on branch <feature>
//   wt list                        feature workspaces and their worktrees
//   wt path <feature> <repo>       print the worktree path (for `cd "$(wt path …)"`)
//   wt remove <feature> <repo> [--force]
//
// Layout: <projects>/<repo> is the main checkout, <projects>/<feature>/<repo>-<feature> the worktree.
// <projects> comes from $WT_PROJECTS, default ~/projects. Uses git only; never copies a repo.

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

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
const worktreeOf = (feature, repo) => join(projects, feature, `${repo}-${feature}`);

function mainCheckout(repo) {
  const dir = join(projects, repo);
  if (!existsSync(join(dir, ".git"))) die(`${repo} is not a git repository in ${projects}`);
  return dir;
}

/** Where a new branch starts: origin's default branch if known, otherwise the main checkout's HEAD. */
function baseRef(main) {
  if (gitOk(main, "fetch", "--quiet", "origin")) {
    if (gitOk(main, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD")) return "origin/HEAD";
  }
  return "HEAD";
}

function create(feature, repo) {
  if (!feature || !repo) die("usage: wt create <feature> <repo>");
  const main = mainCheckout(repo);
  const wt = worktreeOf(feature, repo);
  if (existsSync(wt)) die(`${wt} already exists`);

  const branchExists = gitOk(main, "rev-parse", "--verify", "--quiet", `refs/heads/${feature}`);
  const worktrees = git(main, "worktree", "list", "--porcelain");
  if (worktrees.split("\n").includes(`branch refs/heads/${feature}`)) die(`branch ${feature} is already checked out in another worktree of ${repo}`);

  mkdirSync(join(projects, feature), { recursive: true });
  try {
    if (branchExists) {
      git(main, "worktree", "add", wt, feature);
    } else {
      git(main, "worktree", "add", "-b", feature, wt, baseRef(main));
    }
  } catch (e) {
    // Leave nothing behind if git refused.
    if (!existsSync(wt)) rmSync(join(projects, feature), { recursive: true, force: true });
    die(`git worktree add failed:\n${e.stderr ?? e.message}`);
  }
  console.log(wt);
}

function list() {
  if (!isDir(projects)) die(`${projects} does not exist`);
  let shown = false;
  for (const feature of readdirSync(projects).sort()) {
    const fdir = join(projects, feature);
    if (!isDir(fdir) || feature.startsWith(".")) continue;
    // A feature directory is one that holds worktrees named <repo>-<feature>.
    const entries = readdirSync(fdir).filter((e) => e.endsWith(`-${feature}`) && existsSync(join(fdir, e, ".git")));
    if (!entries.length) continue;
    shown = true;
    console.log(feature);
    for (const e of entries) {
      const repo = e.slice(0, -(feature.length + 1));
      console.log(`  ${repo.padEnd(20)} ${join(fdir, e)}`);
    }
    console.log("");
  }
  if (!shown) console.log("No feature workspaces.");
}

function pathOf(feature, repo) {
  if (!feature || !repo) die("usage: wt path <feature> <repo>");
  const wt = worktreeOf(feature, repo);
  if (!existsSync(join(wt, ".git"))) die(`no worktree for ${repo} in feature ${feature}`);
  console.log(wt);
}

function remove(feature, repo, force) {
  if (!feature || !repo) die("usage: wt remove <feature> <repo> [--force]");
  const main = mainCheckout(repo);
  const wt = worktreeOf(feature, repo);
  if (!existsSync(join(wt, ".git"))) die(`no worktree for ${repo} in feature ${feature}`);
  const dirty = git(wt, "status", "--porcelain").length > 0;
  if (dirty && !force) die(`${wt} has uncommitted changes. Commit them, or use --force to discard them.`);
  try {
    git(main, "worktree", "remove", ...(force ? ["--force"] : []), wt);
  } catch (e) {
    die(`git worktree remove failed:\n${e.stderr ?? e.message}`);
  }
  // The branch is kept on purpose: it may hold commits that were never pushed.
  const fdir = join(projects, feature);
  if (readdirSync(fdir).length === 0) rmSync(fdir, { recursive: true });
  console.log(`Removed ${wt}. Branch ${feature} in ${repo} was kept.`);
}

const [cmd, ...args] = process.argv.slice(2);
const force = args.includes("--force");
const positional = args.filter((a) => a !== "--force");

switch (cmd) {
  case "create":
    create(positional[0], positional[1]);
    break;
  case "list":
    list();
    break;
  case "path":
    pathOf(positional[0], positional[1]);
    break;
  case "remove":
    remove(positional[0], positional[1], force);
    break;
  default:
    console.log(`wt – feature worktrees for one repo at a time

Usage:
  wt create <feature> <repo>
  wt list
  wt path <feature> <repo>
  wt remove <feature> <repo> [--force]

Projects folder: $WT_PROJECTS (default ~/projects).`);
    process.exit(cmd ? 1 : 0);
}
