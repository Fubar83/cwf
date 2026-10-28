#!/usr/bin/env node
// wag (Worktrees, Agents, Git) – feature worktrees across repos, with hooks and start profiles.
//
//   wag                                  list all features
//   wag <feature>                        list the worktrees of a feature
//   wag <feature> <repo>...              create the worktrees if missing, run autostart, print the path
//   wag <feature> <repo>... +<profile>   same, but run the named start profile(s) instead of autostart
//   wag <feature> <repo>... --no-start   same, without running any start profile
//   wag <feature> [<repo>...] --rm       remove the feature's worktrees (all of them if no repo is given)
//
// Rules:
//   - Every repo in a feature gets a branch named <feature>, and a plain `git push` from the worktree sends it
//     to origin/<feature>, the first time and after that. The upstream is set by that first push, not before:
//     an upstream for a branch that is not on origin makes git say "your upstream is gone" on every status.
//   - A repo's main checkout is put back on origin's default branch when a worktree is created, as long as it is
//     clean. That also frees the feature's branch when the main checkout is the thing holding it.
//   - Nothing is guessed. A missing origin, a failed fetch, an invalid name, a branch checked out elsewhere,
//     a local branch that diverged from origin, or a bad config all stop with an error.
//   - Creating is all or nothing: if one repo (or one of its create hooks) fails, every worktree and branch
//     made by that call is rolled back.
//   - Files copied by hooks are kept out of commits (added to the repo's local exclude list).
//
// stdout is only the path: the worktree for one repo, the feature folder for several.
// So `cd "$(wag feature-a repo1)"` works. Everything else goes to stderr.
// Config: $WAG_CONFIG, or $XDG_CONFIG_HOME/wag/config.yaml, or ~/.config/wag/config.yaml.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

class WagError extends Error {}
const fail = (msg) => {
  throw new WagError(msg);
};
const info = (msg) => console.error(msg);
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// ───────────────────────── git ─────────────────────────

function git(cwd, ...args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    throw new WagError(`git ${args.join(" ")} failed: ${String(e.stderr ?? e.message).trim()}`);
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

/** Output of a git command that is allowed to fail, "" when it does (an unset config key, say). */
function gitOut(cwd, ...args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const localRef = (b) => `refs/heads/${b}`;
const remoteRef = (b) => `refs/remotes/origin/${b}`;

// ───────────────────────── config ─────────────────────────

const expandHome = (p) => (p === "~" ? homedir() : p.replace(/^~(?=[\\/])/, homedir()));
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const PROFILE_NAME = /^[A-Za-z0-9_.-]+$/;

function configFile() {
  if (process.env.WAG_CONFIG) return process.env.WAG_CONFIG;
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "wag", "config.yaml");
}

function onlyKeys(obj, allowed, at) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(`config ${at}: unknown key "${k}" (allowed: ${allowed.join(", ")})`);
  }
}

/** A step is { copy: from, to?, optional?, overwrite? } or { run: command }. Start profiles allow only run. */
function parseSteps(list, at, { copy = true } = {}) {
  if (list == null) return [];
  if (!Array.isArray(list)) fail(`config ${at}: must be a list`);
  return list.map((s, i) => {
    const here = `${at}[${i}]`;
    if (!isObject(s)) fail(`config ${here}: must be { ${copy ? "copy: … } or { " : ""}run: … }`);
    if ("run" in s) {
      onlyKeys(s, ["run"], here);
      if (typeof s.run !== "string" || !s.run.trim()) fail(`config ${here}.run: must be a command`);
      return { run: s.run };
    }
    if ("copy" in s && copy) {
      onlyKeys(s, ["copy", "to", "optional", "overwrite"], here);
      if (typeof s.copy !== "string" || !s.copy.trim()) fail(`config ${here}.copy: must be a path`);
      if (s.to !== undefined && (typeof s.to !== "string" || !s.to.trim())) fail(`config ${here}.to: must be a path`);
      for (const k of ["optional", "overwrite"]) {
        if (s[k] !== undefined && typeof s[k] !== "boolean") fail(`config ${here}.${k}: must be true or false`);
      }
      return { copy: s.copy, to: s.to, optional: s.optional === true, overwrite: s.overwrite === true };
    }
    fail(`config ${here}: needs ${copy ? '"copy" or ' : ""}"run"`);
  });
}

function parseHooks(h, at) {
  if (h == null) return { create: [], remove: [] };
  if (!isObject(h)) fail(`config ${at}: must be a mapping`);
  onlyKeys(h, ["create", "remove"], at);
  return { create: parseSteps(h.create, `${at}.create`), remove: parseSteps(h.remove, `${at}.remove`) };
}

/** Loads and validates the config. No file means defaults: ~/projects, no hooks, no start profiles. */
function loadConfig(file = configFile()) {
  let raw = {};
  if (existsSync(file)) {
    try {
      raw = parseYaml(readFileSync(file, "utf8")) ?? {};
    } catch (e) {
      fail(`cannot read ${file}: ${e.message}`);
    }
    if (!isObject(raw)) fail(`config ${file}: must be a mapping`);
  }
  onlyKeys(raw, ["projects", "hooks", "start", "autostart", "repos"], "(root)");
  if (raw.projects !== undefined && typeof raw.projects !== "string") fail("config projects: must be a path");

  const start = {};
  if (raw.start != null) {
    if (!isObject(raw.start)) fail("config start: must be a mapping of profile name to steps");
    for (const [name, steps] of Object.entries(raw.start)) {
      if (!PROFILE_NAME.test(name)) fail(`config start: invalid profile name "${name}"`);
      start[name] = parseSteps(steps, `start.${name}`, { copy: false });
    }
  }
  const autostart = raw.autostart ?? [];
  if (!Array.isArray(autostart) || autostart.some((n) => typeof n !== "string" || !start[n])) {
    fail(`config autostart: must list start profiles defined under "start" (defined: ${Object.keys(start).join(", ") || "none"})`);
  }

  const repos = {};
  if (raw.repos != null) {
    if (!isObject(raw.repos)) fail("config repos: must be a mapping of repo name to settings");
    for (const [name, r] of Object.entries(raw.repos)) {
      const at = `repos.${name}`;
      if (r == null) {
        repos[name] = { path: undefined, create: [], remove: [] };
        continue;
      }
      if (!isObject(r)) fail(`config ${at}: must be a mapping`);
      onlyKeys(r, ["path", "create", "remove"], at);
      if (r.path !== undefined && typeof r.path !== "string") fail(`config ${at}.path: must be a path`);
      repos[name] = {
        path: r.path ? resolve(expandHome(r.path)) : undefined,
        create: parseSteps(r.create, `${at}.create`),
        remove: parseSteps(r.remove, `${at}.remove`),
      };
    }
  }
  return {
    file,
    projects: resolve(expandHome(raw.projects ?? "~/projects")),
    hooks: parseHooks(raw.hooks, "hooks"),
    start,
    autostart,
    repos,
  };
}

// ───────────────────────── layout ─────────────────────────

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

function inside(parent, p) {
  const rel = relative(parent, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function checkName(kind, name) {
  if (!name || name.startsWith("-") || name.includes("/") || !gitOk(homedir(), "check-ref-format", "--branch", name)) {
    fail(`invalid ${kind} name "${name}". Use letters, digits, dashes and dots, no spaces or slashes.`);
  }
}

const featureDir = (cfg, feature) => join(cfg.projects, feature);
const worktreeOf = (cfg, feature, repo) => join(featureDir(cfg, feature), `${repo}-${feature}`);
const hasWorktree = (cfg, feature, repo) => existsSync(join(worktreeOf(cfg, feature, repo), ".git"));

/** Repos that have a worktree in the feature folder. */
function reposIn(cfg, feature) {
  const fdir = featureDir(cfg, feature);
  if (!isDir(fdir)) return [];
  return readdirSync(fdir)
    .filter((e) => e.endsWith(`-${feature}`) && existsSync(join(fdir, e, ".git")))
    .map((e) => e.slice(0, -(feature.length + 1)))
    .sort();
}

const mainDir = (cfg, repo) => cfg.repos[repo]?.path ?? join(cfg.projects, repo);

function mainCheckout(cfg, repo) {
  const dir = mainDir(cfg, repo);
  if (!gitOk(dir, "rev-parse", "--is-inside-work-tree")) fail(`${repo} is not a git repository (looked in ${dir})`);
  if (!gitOk(dir, "remote", "get-url", "origin")) fail(`${repo} has no "origin" remote. wag needs origin to keep branches in sync.`);
  return dir;
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

const PUSH_DEFAULTS = ["", "simple", "current", "upstream"];

/**
 * Makes a plain `git push` from any of the repo's worktrees go to origin/<the branch's own name>, also the
 * very first time, when that branch is not on origin yet. Repo-local, so the main checkout and every worktree
 * share it. Needs git 2.37 for push.autoSetupRemote; without it the first push still needs `git push -u`.
 */
function pushSameName(main) {
  git(main, "config", "push.autoSetupRemote", "true");
  // push.autoSetupRemote only applies to these; with "matching" or "nothing" a plain push sends nothing at all.
  if (!PUSH_DEFAULTS.includes(gitOut(main, "config", "--get", "push.default"))) {
    git(main, "config", "push.default", "current");
  }
}

/**
 * Points the branch's upstream at origin/<same name>, but only once that branch is really on origin.
 * An upstream naming a branch origin does not have is what makes git say "your upstream is gone" on every
 * status in the worktree, so until the first push the branch has none: pushSameName sends that push to the
 * right place anyway, and the push itself sets the upstream.
 */
function syncUpstream(main, branch) {
  if (gitOk(main, "rev-parse", "--verify", "--quiet", remoteRef(branch))) {
    git(main, "config", `branch.${branch}.remote`, "origin");
    git(main, "config", `branch.${branch}.merge`, localRef(branch));
  } else if (gitOut(main, "config", "--get", `branch.${branch}.merge`)) {
    // The upstream git calls "gone": `git worktree add -b` points a new branch at its start point,
    // and an older wag pointed it at a branch nobody had pushed.
    gitOk(main, "config", "--unset", `branch.${branch}.remote`);
    gitOk(main, "config", "--unset", `branch.${branch}.merge`);
  }
}

/**
 * Puts a repo's main checkout back on origin's default branch, so the main checkout is where you expect it
 * and the feature's branch is free for its worktree. Only safe moves: a checkout with uncommitted changes or
 * new files is left alone, and local commits are never touched. Never fails: it is a convenience, and the
 * checks in prepare still have the last word.
 */
function switchMainToDefault(repo, main) {
  try {
    const base = defaultBranch(main);
    const current = git(main, "branch", "--show-current");
    if (current === base) return;
    const where = current || "a detached HEAD";
    if (git(main, "status", "--porcelain").length > 0) {
      return info(`${repo}: main checkout is on ${where} with uncommitted changes, so it was left there`);
    }
    if (gitOk(main, "rev-parse", "--verify", "--quiet", localRef(base))) git(main, "switch", "--quiet", base);
    else git(main, "switch", "--quiet", "--track", "-c", base, `origin/${base}`);
    info(`${repo}: main checkout switched from ${where} to ${base}`);
  } catch (e) {
    info(`${repo}: main checkout was not switched to the default branch: ${e.message}`);
  }
}

// ───────────────────────── hooks ─────────────────────────

const toPosix = (p) => p.split(sep).join("/");

/** Keeps a copied path out of commits: adds it to the repo's local exclude list unless git already ignores it. */
function excludeFromGit(wt, rel) {
  if (gitOk(wt, "check-ignore", "-q", "--", rel)) return;
  const common = resolve(wt, git(wt, "rev-parse", "--git-common-dir"));
  const file = join(common, "info", "exclude");
  const line = `/${toPosix(rel)}`;
  const existing = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  if (existing.includes(line)) return;
  mkdirSync(dirname(file), { recursive: true });
  const prefix = existing.length && existing[existing.length - 1] !== "" ? "\n" : "";
  appendFileSync(file, `${prefix}${line}\n`);
}

function copyStep(step, ctx) {
  const fromRelative = !isAbsolute(step.copy) && !/^~(?=$|[\\/])/.test(step.copy);
  // Relative sources come from the repo's main checkout, e.g. its untracked .env.
  const from = fromRelative ? resolve(ctx.main, step.copy) : resolve(expandHome(step.copy));
  if (!existsSync(from)) {
    if (step.optional) return info(`  skip copy: ${from} does not exist (optional)`);
    fail(`copy: ${from} does not exist`);
  }
  const rel = step.to ?? (fromRelative ? step.copy : basename(from));
  const to = resolve(ctx.wt, rel);
  if (!inside(ctx.wt, to) || to === ctx.wt) fail(`copy: "${rel}" points outside the worktree`);
  const relInWt = relative(ctx.wt, to);
  const tracked = gitOk(ctx.wt, "ls-files", "--error-unmatch", "--", relInWt);
  if (existsSync(to) && !step.overwrite) {
    fail(`copy: ${relInWt} already exists in the worktree. Set "overwrite: true" to replace it.`);
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, force: true });
  if (tracked) info(`  copied ${relInWt} over a tracked file; it will show as modified`);
  else {
    excludeFromGit(ctx.wt, relInWt);
    info(`  copied ${relInWt}`);
  }
}

/** Runs a shell command. Its stdout goes to our stderr, so stdout stays only the path. */
function runCommand(command, cwd, env) {
  info(`  run: ${command.split("\n")[0]}${command.includes("\n") ? " …" : ""}`);
  const r = spawnSync(command, { cwd, shell: true, stdio: ["inherit", 2, 2], env: { ...process.env, ...env } });
  if (r.error) fail(`run "${command}" could not start: ${r.error.message}`);
  if (r.status !== 0) fail(`run "${command.split("\n")[0]}" failed with exit code ${r.status}`);
}

/** Create and remove hooks for one worktree: global steps first, then the repo's own. */
function runHooks(cfg, event, ctx) {
  const steps = [...cfg.hooks[event], ...(cfg.repos[ctx.repo]?.[event] ?? [])];
  if (!steps.length) return;
  info(`${event} hooks for ${ctx.repo}-${ctx.feature}:`);
  const env = { WAG_FEATURE: ctx.feature, WAG_BRANCH: ctx.feature, WAG_REPO: ctx.repo, WAG_WORKTREE: ctx.wt, WAG_MAIN: ctx.main };
  for (const step of steps) {
    if (step.run !== undefined) runCommand(step.run, ctx.wt, env);
    else copyStep(step, ctx);
  }
}

/**
 * Start profiles run once per call, for the whole feature, in the printed path.
 * WAG_WORKTREES and WAG_REPOS are newline-separated, in the same order.
 */
function runStart(cfg, names, ctx) {
  const env = {
    WAG_FEATURE: ctx.feature,
    WAG_BRANCH: ctx.feature,
    WAG_FEATURE_DIR: ctx.featureDir,
    WAG_REPOS: ctx.repos.join("\n"),
    WAG_WORKTREES: ctx.worktrees.join("\n"),
    ...(ctx.repos.length === 1 ? { WAG_REPO: ctx.repos[0], WAG_WORKTREE: ctx.worktrees[0] } : {}),
  };
  for (const name of names) {
    const steps = cfg.start[name];
    if (!steps) fail(`no start profile "${name}" (defined: ${Object.keys(cfg.start).join(", ") || "none"})`);
    info(`start ${name} for ${ctx.feature}:`);
    for (const step of steps) runCommand(step.run, ctx.cwd, env);
  }
}

// ───────────────────────── create and remove ─────────────────────────

/**
 * Checks that a repo can get a worktree for the feature. Its one change to the repo is putting the main
 * checkout back on the default branch, which also frees the feature's branch when the main checkout sits on it.
 */
function prepare(cfg, feature, repo) {
  checkName("repo", repo);
  const main = mainCheckout(cfg, repo);
  const wt = worktreeOf(cfg, feature, repo);
  if (existsSync(wt)) fail(`${wt} already exists but is not a worktree. Remove it by hand.`);

  git(main, "fetch", "--quiet", "--prune", "origin");
  switchMainToDefault(repo, main);
  if (git(main, "worktree", "list", "--porcelain").split("\n").includes(`branch ${localRef(feature)}`)) {
    fail(`branch ${feature} is already checked out in another worktree of ${repo}`);
  }
  const localExists = gitOk(main, "rev-parse", "--verify", "--quiet", localRef(feature));
  const remoteExists = gitOk(main, "rev-parse", "--verify", "--quiet", remoteRef(feature));
  let fastForward = false;
  if (localExists && remoteExists) {
    const localBehind = gitOk(main, "merge-base", "--is-ancestor", localRef(feature), remoteRef(feature));
    const remoteBehind = gitOk(main, "merge-base", "--is-ancestor", remoteRef(feature), localRef(feature));
    if (!localBehind && !remoteBehind) {
      fail(`local ${feature} and origin/${feature} have diverged in ${repo}. Reconcile them in ${main} first.`);
    }
    fastForward = localBehind && !remoteBehind;
  }
  const start = localExists ? undefined : remoteExists ? remoteRef(feature) : remoteRef(defaultBranch(main));
  return { repo, main, wt, localExists, remoteExists, start, fastForward };
}

/** Creates one prepared worktree and runs its create hooks. Returns an undo function. */
function createOne(cfg, feature, p) {
  let createdBranch = false;
  const undo = () => {
    if (existsSync(p.wt)) {
      gitOk(p.main, "worktree", "remove", "--force", p.wt);
      rmSync(p.wt, { recursive: true, force: true });
      gitOk(p.main, "worktree", "prune");
    }
    if (createdBranch) gitOk(p.main, "branch", "-D", feature);
  };
  try {
    if (p.localExists) git(p.main, "worktree", "add", p.wt, feature);
    else {
      git(p.main, "worktree", "add", "-b", feature, p.wt, p.start);
      createdBranch = true;
    }
    if (p.fastForward) git(p.wt, "merge", "--ff-only", remoteRef(feature));
    pushSameName(p.main);
    syncUpstream(p.main, feature);
    runHooks(cfg, "create", { feature, repo: p.repo, wt: p.wt, main: p.main });
  } catch (e) {
    undo();
    throw e;
  }
  const onOrigin = `tracking origin/${feature}`;
  const notYet = `not on origin yet; a plain git push creates origin/${feature}`;
  info(`Created ${p.repo}-${feature} on branch ${feature}, ${p.remoteExists ? onOrigin : notYet}.`);
  return undo;
}

/**
 * Brings a worktree that already exists up to what wag sets today: the push config, and an upstream that git
 * would call "gone". Local refs only, so no fetch, and a failure here never stops opening the feature.
 */
function repair(cfg, feature, repo) {
  const main = mainDir(cfg, repo);
  if (!gitOk(main, "remote", "get-url", "origin")) return;
  try {
    pushSameName(main);
    syncUpstream(main, feature);
  } catch (e) {
    info(`${repo}: could not check how ${feature} pushes to origin: ${e.message}`);
  }
}

/** Creates the missing worktrees, all or nothing. */
function createAll(cfg, feature, repos) {
  const fdir = featureDir(cfg, feature);
  if (existsSync(join(fdir, ".git"))) fail(`${fdir} is a repository; pick a feature name that is not a repo name`);
  for (const repo of repos.filter((r) => hasWorktree(cfg, feature, r))) repair(cfg, feature, repo);
  const missing = repos.filter((r) => !hasWorktree(cfg, feature, r));
  if (!missing.length) return;
  // Check every repo before touching any of them.
  const prepared = missing.map((r) => prepare(cfg, feature, r));
  const fdirExisted = existsSync(fdir);
  mkdirSync(fdir, { recursive: true });
  const undos = [];
  try {
    for (const p of prepared) undos.push(createOne(cfg, feature, p));
  } catch (e) {
    for (const undo of undos.reverse()) undo();
    if (!fdirExisted && existsSync(fdir) && !readdirSync(fdir).length) rmSync(fdir, { recursive: true });
    if (undos.length) info(`Rolled back ${undos.length} worktree(s) created by this call.`);
    throw e;
  }
}

/** Removes worktrees. Checks all of them and runs all remove hooks before removing any. */
function removeAll(cfg, feature, repos, force) {
  if (!repos.length) fail(`no worktrees for ${feature}`);
  const targets = repos.map((repo) => {
    checkName("repo", repo);
    if (!hasWorktree(cfg, feature, repo)) fail(`no worktree for ${repo} in ${feature}`);
    return { repo, wt: worktreeOf(cfg, feature, repo), main: mainCheckout(cfg, repo) };
  });
  if (!force) {
    const dirty = targets.filter((t) => git(t.wt, "status", "--porcelain").length > 0).map((t) => t.wt);
    if (dirty.length) fail(`uncommitted changes in:\n  ${dirty.join("\n  ")}\nCommit them, or add --force to discard them. Nothing was removed.`);
  }
  for (const t of targets) {
    try {
      runHooks(cfg, "remove", { feature, ...t });
    } catch (e) {
      if (!force) throw new WagError(`${e.message}\nNothing was removed. Fix the hook, or add --force to remove anyway.`);
      info(`Ignoring the failing hook because of --force: ${e.message}`);
    }
  }
  for (const t of targets) {
    git(t.main, "worktree", "remove", ...(force ? ["--force"] : []), t.wt);
    info(`Removed ${t.wt}. Branch ${feature} in ${t.repo} was kept.`);
  }
  const fdir = featureDir(cfg, feature);
  if (existsSync(fdir) && readdirSync(fdir).length === 0) rmSync(fdir, { recursive: true });
}

/** Worktrees of one feature, or of all features when feature is undefined. */
function list(cfg, feature) {
  if (!isDir(cfg.projects)) fail(`${cfg.projects} does not exist (set "projects" in ${cfg.file})`);
  const features = feature ? [feature] : readdirSync(cfg.projects).filter((f) => isDir(join(cfg.projects, f)) && !f.startsWith("."));
  let shown = false;
  for (const f of features.sort()) {
    const repos = reposIn(cfg, f);
    if (!repos.length) continue;
    shown = true;
    console.log(f);
    for (const r of repos) console.log(`  ${r.padEnd(20)} ${worktreeOf(cfg, f, r)}`);
  }
  if (!shown) console.log(feature ? `No worktrees for ${feature}.` : "No features yet. Create one with: wag <feature> <repo>...");
}

// ───────────────────────── CLI ─────────────────────────

const usage = () => `wag (Worktrees, Agents, Git) – feature worktrees across repos

Usage:
  wag                                  list all features
  wag <feature>                        list the worktrees of a feature
  wag <feature> <repo>...              create the worktrees if missing, run autostart, print the path
  wag <feature> <repo>... +<profile>   same, but run the named start profile(s) instead of autostart
  wag <feature> <repo>... --no-start   same, without running any start profile
  wag <feature> [<repo>...] --rm       remove the worktrees (all of the feature's if no repo is given);
                                         --force discards uncommitted changes and ignores failing hooks
  wag --version                          print the version

Config: ${configFile()}`;

const FLAGS = ["--rm", "--force", "--no-start"];

function main(argv) {
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(VERSION);
    return 0;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const rm = argv.includes("--rm");
  const force = argv.includes("--force");
  const noStart = argv.includes("--no-start");
  const picked = argv.filter((a) => a.startsWith("+")).map((a) => a.slice(1));
  const unknown = argv.filter((a) => a.startsWith("-") && !FLAGS.includes(a));
  const [feature, ...repos] = argv.filter((a) => !a.startsWith("-") && !a.startsWith("+"));
  const opening = feature && repos.length && !rm;
  const dupes = repos.filter((r, i) => repos.indexOf(r) !== i);
  if (
    unknown.length || dupes.length || (force && !rm) || (rm && !feature) ||
    ((picked.length || noStart) && !opening) || (picked.length && noStart) ||
    picked.some((p) => !PROFILE_NAME.test(p))
  ) {
    console.error(usage());
    return 1;
  }
  const cfg = loadConfig();
  if (!feature) return list(cfg, undefined), 0;
  checkName("feature", feature);
  if (rm) return removeAll(cfg, feature, repos.length ? repos : reposIn(cfg, feature), force), 0;
  if (!repos.length) return list(cfg, feature), 0;

  createAll(cfg, feature, repos);
  const worktrees = repos.map((r) => worktreeOf(cfg, feature, r));
  const path = repos.length === 1 ? worktrees[0] : featureDir(cfg, feature);
  // Start profiles run every time you open the feature; a failure here never removes anything.
  const profiles = picked.length ? picked : noStart ? [] : cfg.autostart;
  runStart(cfg, profiles, { feature, featureDir: featureDir(cfg, feature), repos, worktrees, cwd: path });
  console.log(path);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`wag: ${e instanceof WagError ? e.message : e?.stack ?? e}`);
  process.exitCode = 1;
}
