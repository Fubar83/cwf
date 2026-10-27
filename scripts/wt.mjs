#!/usr/bin/env node
// wt – one command for feature worktrees.
//
//   wt                          list all features
//   wt <feature>                list the worktrees of a feature
//   wt <feature> <repo>         create the worktree if missing, then print its path
//   wt <feature> <repo> --rm    remove that worktree (--force discards uncommitted changes)
//
// Rules:
//   - A feature's branch has the same name locally and on origin: <repo> tracks origin/<feature>.
//   - Nothing is guessed. A missing origin, a failed fetch, an invalid name, a branch checked out
//     elsewhere, or a local branch that has diverged from origin all stop with an error.
//   - A failed create is rolled back, so no half-made worktree or branch is left behind.
//
// Only the path goes to stdout, so `cd "$(wt feature-a repo1)"` works. Messages go to stderr.
// Layout: <projects>/<repo> is the main checkout, <projects>/<feature>/<repo>-<feature> the worktree.
// <projects> is $WT_PROJECTS, default ~/projects. Uses git only; never copies a repo.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const projects = process.env.WT_PROJECTS ?? join(homedir(), "projects");

class WtError extends Error {}
const fail = (msg) => {
  throw new WtError(msg);
};

function git(cwd, ...args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const detail = String(e.stderr ?? e.message).trim();
    throw new WtError(`git ${args.join(" ")} failed: ${detail}`);
  }
}

function gitOk(cwd, ...args) {
  try {
    execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

const info = (msg) => console.error(msg);
const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
const worktreeOf = (feature, repo) => join(projects, feature, `${repo}-${feature}`);
const hasWorktree = (feature, repo) => existsSync(join(worktreeOf(feature, repo), ".git"));
const localRef = (b) => `refs/heads/${b}`;
const remoteRef = (b) => `refs/remotes/origin/${b}`;

/** Refuses names git would reject, and names that look like options. */
function checkName(kind, name) {
  if (!name || name.startsWith("-") || !gitOk(homedir(), "check-ref-format", "--branch", name)) {
    fail(`invalid ${kind} name "${name}". Use letters, digits, dashes and dots, no spaces.`);
  }
}

function mainCheckout(repo) {
  const dir = join(projects, repo);
  if (!gitOk(dir, "rev-parse", "--is-inside-work-tree")) fail(`${repo} is not a git repository in ${projects}`);
  if (!gitOk(dir, "remote", "get-url", "origin")) fail(`${repo} has no "origin" remote. wt needs origin to keep branches in sync.`);
  return dir;
}

/** Fetches origin. A failed fetch is an error, never a silent fallback to a stale base. */
function fetchOrigin(main) {
  git(main, "fetch", "--quiet", "--prune", "origin");
}

/** origin's default branch, from origin/HEAD. Refuses if it cannot be determined. */
function defaultBranch(main) {
  if (!gitOk(main, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD")) {
    gitOk(main, "remote", "set-head", "origin", "--auto");
  }
  if (!gitOk(main, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD")) {
    fail("cannot determine origin's default branch (git remote set-head origin --auto failed)");
  }
  return git(main, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "");
}

/** Makes the local branch push to origin/<same name>, so `git push` never needs a refspec. */
function trackSameName(main, branch) {
  git(main, "config", `branch.${branch}.remote`, "origin");
  git(main, "config", `branch.${branch}.merge`, localRef(branch));
}

function checkedOutElsewhere(main, branch) {
  return git(main, "worktree", "list", "--porcelain").split("\n").includes(`branch ${localRef(branch)}`);
}

function create(feature, repo) {
  checkName("feature", feature);
  checkName("repo", repo);
  const main = mainCheckout(repo);
  const wt = worktreeOf(feature, repo);
  if (existsSync(wt)) fail(`${wt} already exists but is not a worktree. Remove it by hand.`);
  fetchOrigin(main);

  if (checkedOutElsewhere(main, feature)) fail(`branch ${feature} is already checked out in another worktree of ${repo}`);

  const localExists = gitOk(main, "rev-parse", "--verify", "--quiet", localRef(feature));
  const remoteExists = gitOk(main, "rev-parse", "--verify", "--quiet", remoteRef(feature));
  let fastForward = false;
  if (localExists && remoteExists) {
    const localIsBehind = gitOk(main, "merge-base", "--is-ancestor", localRef(feature), remoteRef(feature));
    const remoteIsBehind = gitOk(main, "merge-base", "--is-ancestor", remoteRef(feature), localRef(feature));
    if (!localIsBehind && !remoteIsBehind) {
      fail(`local ${feature} and origin/${feature} have diverged in ${repo}. Reconcile them in ${main} first.`);
    }
    fastForward = localIsBehind && !remoteIsBehind;
  }

  mkdirSync(join(projects, feature), { recursive: true });
  let createdBranch = false;
  try {
    if (localExists) {
      git(main, "worktree", "add", wt, feature);
    } else {
      const start = remoteExists ? remoteRef(feature) : `${remoteRef(defaultBranch(main))}`;
      git(main, "worktree", "add", "-b", feature, wt, start);
      createdBranch = true;
    }
    trackSameName(main, feature);
    if (fastForward) git(wt, "merge", "--ff-only", remoteRef(feature));
  } catch (e) {
    // Roll back: nothing half-made should remain.
    if (existsSync(wt)) gitOk(main, "worktree", "remove", "--force", wt);
    if (createdBranch) gitOk(main, "branch", "-D", feature);
    if (!readdirSync(join(projects, feature)).length) rmSync(join(projects, feature), { recursive: true });
    throw e;
  }
  info(`Created ${repo}-${feature} on branch ${feature}, tracking origin/${feature}.`);
  return wt;
}

function remove(feature, repo, force) {
  checkName("feature", feature);
  checkName("repo", repo);
  if (!hasWorktree(feature, repo)) fail(`no worktree for ${repo} in ${feature}`);
  const main = mainCheckout(repo);
  const wt = worktreeOf(feature, repo);
  if (!force && git(wt, "status", "--porcelain").length > 0) {
    fail(`${wt} has uncommitted changes. Commit them, or add --force to discard them.`);
  }
  git(main, "worktree", "remove", ...(force ? ["--force"] : []), wt);
  const fdir = join(projects, feature);
  if (readdirSync(fdir).length === 0) rmSync(fdir, { recursive: true });
  info(`Removed ${wt}. Branch ${feature} in ${repo} was kept.`);
}

/** Worktrees of one feature, or of all features when feature is undefined. */
function list(feature) {
  if (!isDir(projects)) fail(`${projects} does not exist`);
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

const USAGE = `Usage:
  wt                          list all features
  wt <feature>                list the worktrees of a feature
  wt <feature> <repo>         create the worktree if missing, then print its path
  wt <feature> <repo> --rm    remove it (add --force to discard uncommitted changes)`;

function main() {
  const args = process.argv.slice(2);
  const rm = args.includes("--rm");
  const force = args.includes("--force");
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--rm" && a !== "--force");
  const [feature, repo, extra] = args.filter((a) => !a.startsWith("--"));

  if (unknown.length || extra !== undefined || (force && !rm) || (rm && !repo) || (rm && !feature)) {
    console.error(USAGE);
    return 1;
  }
  if (!feature) list(undefined);
  else if (!repo) list(feature);
  else if (rm) remove(feature, repo, force);
  else console.log(hasWorktree(feature, repo) ? worktreeOf(feature, repo) : create(feature, repo));
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`wt: ${e instanceof WtError ? e.message : e.stack ?? e}`);
  process.exitCode = 1;
}
