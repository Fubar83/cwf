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
//   - Main checkouts live in "projects". Feature folders go there too, or in a folder inside it that the
//     "features" setting names, like "_features". It is always inside projects, never anywhere else.
//   - A feature may be a path, like feature/abc123. The branch is that whole name; the feature folder is it
//     with dashes for slashes (feature-abc123), and inside it each worktree is named after its repo alone.
//     A trailing slash on any argument is dropped, so tab-completed names work: wag feature/abc123 repo-1/
//   - Every repo in a feature gets a branch named <feature>, and a plain `git push` from the worktree sends it
//     to origin/<feature>, the first time and after that. The upstream is set by that first push, not before:
//     an upstream for a branch that is not on origin makes git say "your upstream is gone" on every status.
//   - A repo's main checkout is put back on origin's default branch when a worktree is created, as long as it is
//     clean. That also frees the feature's branch when the main checkout is the thing holding it.
//   - A hook or start step is one bash command line, written as a plain string. A step whose first word is a
//     file next to the config file is run as that script with bash, arguments and all.
//   - Hooks say which level they are on: hooks.repo (and the same create/remove keys under repos.<name>) runs
//     for one worktree at a time, in it, while hooks.feature runs once for the whole feature, in the feature
//     folder, when the feature itself appears and before it goes away.
//   - Nothing is guessed. A missing origin, a failed fetch, an invalid name, a branch checked out elsewhere,
//     a local branch that diverged from origin, or a bad config all stop with an error.
//   - Creating is all or nothing: if one repo (or one of its create hooks) fails, every worktree and branch
//     made by that call is rolled back.
//
// stdout is only the path: the worktree for one repo, the feature folder for several.
// So `cd "$(wag feature-a repo1)"` works. Everything else goes to stderr.
// Config: $WAG_CONFIG, or $XDG_CONFIG_HOME/wag/config.yaml, or ~/.config/wag/config.yaml.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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

/**
 * Where feature folders go: the projects folder, or a folder inside it that "features" names, like
 * "_features". Nothing else, so one setting cannot send worktrees off to an unrelated part of the disk.
 */
function featuresDir(projects, value) {
  if (!value) return projects;
  const dir = resolve(projects, value);
  if (isAbsolute(value) || value.startsWith("~") || !inside(projects, dir)) {
    fail(`config features: must be a folder inside projects, like "_features" (got "${value}")`);
  }
  return dir;
}

function onlyKeys(obj, allowed, at) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(`config ${at}: unknown key "${k}" (allowed: ${allowed.join(", ")})`);
  }
}

/**
 * A step is a command, written as a plain string: a bash command line, or the name of a script file next
 * to the config file. There is nothing to name it, so there is no "run:" and no copy step either: copying
 * a file in is `cp`, like it would be in any script.
 */
function parseSteps(list, at) {
  if (list == null) return [];
  if (!Array.isArray(list)) fail(`config ${at}: must be a list of commands`);
  return list.map((s, i) => {
    if (typeof s !== "string" || !s.trim()) {
      const was = isObject(s) ? ` (a mapping: "run:" and "copy:" are gone, write the command on its own)` : "";
      fail(`config ${at}[${i}]: must be a command, as a string${was}`);
    }
    return s;
  });
}

/** The create and remove steps of one hook block. */
function parseEvents(h, at) {
  if (h == null) return { create: [], remove: [] };
  if (!isObject(h)) fail(`config ${at}: must be a mapping`);
  onlyKeys(h, ["create", "remove"], at);
  return { create: parseSteps(h.create, `${at}.create`), remove: parseSteps(h.remove, `${at}.remove`) };
}

/**
 * Two levels, each with its own create and remove: "repo" for every repo of the feature, one worktree at a
 * time, and "feature" for the whole feature, once. The steps used to sit directly under hooks, where they were
 * the per-repo ones, so that spelling is an error that names both levels rather than just an unknown key.
 */
function parseHooks(h, at) {
  if (h == null) return { repo: parseEvents(null, at), feature: parseEvents(null, at) };
  if (!isObject(h)) fail(`config ${at}: must be a mapping`);
  for (const event of ["create", "remove"]) {
    if (h[event] !== undefined) {
      fail(`config ${at}.${event}: hooks now name their level, so move these steps to ${at}.repo.${event} (for every repo) or ${at}.feature.${event} (once for the whole feature)`);
    }
  }
  onlyKeys(h, ["repo", "feature"], at);
  return { repo: parseEvents(h.repo, `${at}.repo`), feature: parseEvents(h.feature, `${at}.feature`) };
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
  onlyKeys(raw, ["projects", "features", "hooks", "start", "autostart", "repos"], "(root)");
  if (raw.projects !== undefined && typeof raw.projects !== "string") fail("config projects: must be a path");
  if (raw.features !== undefined && typeof raw.features !== "string") fail("config features: must be a path");

  const start = {};
  if (raw.start != null) {
    if (!isObject(raw.start)) fail("config start: must be a mapping of profile name to steps");
    for (const [name, steps] of Object.entries(raw.start)) {
      if (!PROFILE_NAME.test(name)) fail(`config start: invalid profile name "${name}"`);
      start[name] = parseSteps(steps, `start.${name}`);
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
  const projects = resolve(expandHome(raw.projects ?? "~/projects"));
  const features = featuresDir(projects, raw.features);
  return {
    file,
    dir: dirname(file),
    projects,
    features,
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

/**
 * A feature may be a path, like feature/abc123, because a branch may be; a repo is one folder name.
 * git check-ref-format does the real work: it already refuses a leading or trailing slash, a double
 * slash, a ".." or ".x" segment and everything else that is not a branch name, so a feature can never
 * reach outside the projects folder.
 */
function checkName(kind, name) {
  const slashes = kind === "feature";
  if (!name || name.startsWith("-") || (!slashes && name.includes("/")) || !gitOk(homedir(), "check-ref-format", "--branch", name)) {
    const allowed = slashes ? "slashes are allowed, spaces are not" : "no spaces or slashes";
    fail(`invalid ${kind} name "${name}". Use letters, digits, dashes and dots; ${allowed}.`);
  }
}

/**
 * One flat folder per feature, named after the branch with its slashes turned into dashes, so
 * feature/abc123 is the folder feature-abc123. Inside it a worktree is named after its repo and nothing
 * else: the folder it sits in already says which feature it belongs to.
 */
const folderOf = (feature) => feature.replaceAll("/", "-");

const featureDir = (cfg, feature) => join(cfg.features, folderOf(feature));
const worktreeOf = (cfg, feature, repo) => join(featureDir(cfg, feature), repo);
const hasWorktree = (cfg, feature, repo) => existsSync(join(worktreeOf(cfg, feature, repo), ".git"));

/** Repos that have a worktree in the feature folder: every worktree in it, by its folder name. */
function reposIn(cfg, feature) {
  const fdir = featureDir(cfg, feature);
  if (!isDir(fdir)) return [];
  return readdirSync(fdir)
    .filter((e) => existsSync(join(fdir, e, ".git")))
    .sort();
}

/** The branch a worktree is on, "" when it has none or git cannot say. */
const branchIn = (wt) => gitOut(wt, "branch", "--show-current");

/**
 * Features that have worktrees, by name. The folder name is the branch with dashes for slashes, which is
 * not reversible, so the name comes from the branch its worktrees are on; the folder name is the fallback.
 */
function featuresIn(cfg) {
  return readdirSync(cfg.features)
    // A repository is a main checkout, never a feature folder, so its own contents are never read: a repo
    // with a nested one in it (a submodule, something vendored under node_modules) is not a feature.
    .filter((e) => !e.startsWith(".") && isDir(join(cfg.features, e)) && !existsSync(join(cfg.features, e, ".git")))
    .map((e) => {
      const repos = reposIn(cfg, e);
      return repos.length ? branchIn(join(cfg.features, e, repos[0])) || e : undefined;
    })
    .filter(Boolean);
}

/** Drops the feature folder once it is empty. The features folder itself is left alone. */
function pruneFeatureDir(cfg, feature) {
  const dir = featureDir(cfg, feature);
  if (dir !== cfg.features && isDir(dir) && !readdirSync(dir).length) rmSync(dir, { recursive: true });
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

// ───────────────────────── steps ─────────────────────────

const toPosix = (p) => p.split(sep).join("/");
const shQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

// Windows ships this as an app alias for the Windows Subsystem for Linux. It is a Linux bash: a Windows
// path means nothing in it (C:/… does not exist, node is not on its PATH), so it can never run a step.
const WSL_LAUNCHER = /[\\/](WindowsApps|System32)[\\/]bash\.exe$/i;

/**
 * The bash that steps run with, worked out once. On Windows "bash" on PATH is usually the WSL launcher
 * above, so Git's own bash is looked for first, next to the git wag already needs: Git for Windows keeps
 * it in bin/bash.exe beside the folders git --exec-path points into. $WAG_BASH overrides all of it.
 */
let bashExe;
function bash() {
  if (bashExe) return bashExe;
  if (process.env.WAG_BASH) return (bashExe = process.env.WAG_BASH);
  if (process.platform !== "win32") return (bashExe = "bash");
  for (let dir = gitOut(homedir(), "--exec-path"); dir && dir !== dirname(dir); dir = dirname(dir)) {
    for (const rel of [["bin", "bash.exe"], ["usr", "bin", "bash.exe"]]) {
      if (existsSync(join(dir, ...rel))) return (bashExe = join(dir, ...rel));
    }
  }
  const onPath = gitOut(homedir(), "--version") && firstOnPath("bash");
  if (onPath && !WSL_LAUNCHER.test(onPath)) return (bashExe = onPath);
  fail(
    `no bash to run steps with.${onPath ? ` The "bash" on PATH is ${onPath}, the Windows Subsystem for Linux launcher, which cannot see Windows paths.` : ""}` +
      ` wag looks for Git's own bash next to git: install Git for Windows, or point WAG_BASH at a bash.exe.`,
  );
}

/** The first match for a command on PATH, "" when there is none. */
function firstOnPath(cmd) {
  try {
    return execFileSync("where", [cmd], { encoding: "utf8" }).split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  } catch {
    return "";
  }
}

/** The script a step names, when its first word is a file next to the config file, else "". */
function scriptOf(cfg, command) {
  if (command.includes("\n")) return ""; // a block is written inline, not a file name
  const first = command.trim().split(/\s+/)[0];
  if (first.includes("/") || first.includes("\\")) return "";
  const file = join(cfg.dir, first);
  return existsSync(file) && statSync(file).isFile() ? file : "";
}

/**
 * Runs one step with bash: in the worktree for a hook, in the printed path for a start profile. A step whose
 * first word is a file next to the config file is run as a script with bash, so it needs no execute bit and
 * no shebang, and keeps the arguments written after it. Everything else is a bash command line.
 * Its stdout goes to our stderr, so stdout stays only the path.
 */
function runCommand(cfg, command, cwd, env) {
  const line = command.trim().split("\n")[0] + (command.includes("\n") ? " …" : "");
  const script = scriptOf(cfg, command);
  info(`  $ ${line}${script ? `   (script next to ${basename(cfg.file)})` : ""}`);
  const first = command.trim().split(/\s+/)[0];
  const run = script ? `bash ${shQuote(toPosix(script))}${command.trim().slice(first.length)}` : command;
  const r = spawnSync(bash(), ["-c", run], { cwd, stdio: ["inherit", 2, 2], env: { ...process.env, ...env } });
  if (r.error) fail(`"${line}" could not start with ${bash()}: ${r.error.message}`);
  if (r.status !== 0) fail(`"${line}" failed with exit code ${r.status}`);
}

/** Repo hooks run for one worktree, in it: the steps for every repo first, then that repo's own. */
function runRepoHooks(cfg, event, ctx) {
  const steps = [...cfg.hooks.repo[event], ...(cfg.repos[ctx.repo]?.[event] ?? [])];
  if (!steps.length) return;
  info(`repo ${event} hooks for ${folderOf(ctx.feature)}/${ctx.repo}:`);
  const env = { WAG_FEATURE: ctx.feature, WAG_BRANCH: ctx.feature, WAG_REPO: ctx.repo, WAG_WORKTREE: ctx.wt, WAG_MAIN: ctx.main };
  for (const step of steps) runCommand(cfg, step, ctx.wt, env);
}

/**
 * Feature hooks run once for the whole feature, in the feature folder, with every repo of it in WAG_REPOS:
 * create once the feature's worktrees are all there and their own create hooks have run, remove before the
 * last of them is taken away. Adding a repo to a feature that already exists is not the feature appearing,
 * and removing one repo of several is not it going away, so neither runs then.
 * There is no WAG_REPO or WAG_WORKTREE here, not even for a feature with one repo: a step that reaches for
 * one would work on such a feature and then quietly do nothing on the next, which has two. Repo hooks are
 * where a single repo is the subject; here the repos are a list.
 */
function runFeatureHooks(cfg, event, { feature, repos, worktrees }) {
  const steps = cfg.hooks.feature[event];
  if (!steps.length) return;
  const dir = featureDir(cfg, feature);
  info(`feature ${event} hooks for ${folderOf(feature)}:`);
  const env = {
    WAG_FEATURE: feature,
    WAG_BRANCH: feature,
    WAG_FEATURE_DIR: dir,
    WAG_REPOS: repos.join("\n"),
    WAG_WORKTREES: worktrees.join("\n"),
  };
  for (const step of steps) runCommand(cfg, step, dir, env);
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
    for (const step of steps) runCommand(cfg, step, ctx.cwd, env);
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
    runRepoHooks(cfg, "create", { feature, repo: p.repo, wt: p.wt, main: p.main });
  } catch (e) {
    undo();
    throw e;
  }
  const onOrigin = `tracking origin/${feature}`;
  const notYet = `not on origin yet; a plain git push creates origin/${feature}`;
  info(`Created ${folderOf(feature)}/${p.repo} on branch ${feature}, ${p.remoteExists ? onOrigin : notYet}.`);
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
  if (existsSync(join(cfg.features, ".git"))) {
    fail(`${cfg.features} is a repository, so feature folders cannot go in it. Point "features" somewhere else in ${cfg.file}.`);
  }
  if (existsSync(join(fdir, ".git"))) fail(`${fdir} is a repository; pick a feature name that is not a repo name`);
  // Slashes become dashes, so feature/abc123 and feature-abc123 want the same folder. Whoever is in it keeps it.
  const existing = reposIn(cfg, feature);
  const taken = existing.map((r) => branchIn(worktreeOf(cfg, feature, r))).find((b) => b && b !== feature);
  if (taken) fail(`${fdir} already holds ${taken}, which uses the same folder name as ${feature}. Pick another name.`);
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
    // The feature itself is new when it had no worktrees at all, and its hooks see every one of them.
    if (!existing.length) {
      const all = reposIn(cfg, feature);
      runFeatureHooks(cfg, "create", { feature, repos: all, worktrees: all.map((r) => worktreeOf(cfg, feature, r)) });
    }
  } catch (e) {
    for (const undo of undos.reverse()) undo();
    if (!fdirExisted) pruneFeatureDir(cfg, feature);
    if (undos.length) info(`Rolled back ${undos.length} worktree(s) created by this call.`);
    // A feature hook may have written something before it failed, and pruning only takes an empty folder.
    if (!fdirExisted && isDir(fdir)) info(`${fdir} was left behind: it still holds files a hook made.`);
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
  const hook = (run) => {
    try {
      run();
    } catch (e) {
      if (!force) throw new WagError(`${e.message}\nNothing was removed. Fix the hook, or add --force to remove anyway.`);
      info(`Ignoring the failing hook because of --force: ${e.message}`);
    }
  };
  // The whole feature is going when nothing of it is left behind; its hooks run first, while everything is there.
  if (reposIn(cfg, feature).every((r) => repos.includes(r))) {
    hook(() => runFeatureHooks(cfg, "remove", { feature, repos: targets.map((t) => t.repo), worktrees: targets.map((t) => t.wt) }));
  }
  for (const t of targets) hook(() => runRepoHooks(cfg, "remove", { feature, ...t }));
  for (const t of targets) {
    git(t.main, "worktree", "remove", ...(force ? ["--force"] : []), t.wt);
    info(`Removed ${t.wt}. Branch ${feature} in ${t.repo} was kept.`);
  }
  pruneFeatureDir(cfg, feature);
  const fdir = featureDir(cfg, feature);
  if (isDir(fdir)) info(`${fdir} was kept: it still holds files that are not worktrees.`);
}

/** Worktrees of one feature, or of all features when feature is undefined. */
function list(cfg, feature) {
  if (!isDir(cfg.projects)) fail(`${cfg.projects} does not exist (set "projects" in ${cfg.file})`);
  // The features folder is made when the first worktree is: until then there is simply nothing to list.
  const features = feature ? [feature] : isDir(cfg.features) ? featuresIn(cfg) : [];
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

A feature may be a path, like feature/abc123: the branch keeps the slashes, its folder uses dashes.
A trailing slash, which tab completion adds to a folder name, is ignored: wag feature/abc123 repo-1/ repo-2/

Config: ${configFile()}`;

const FLAGS = ["--rm", "--force", "--no-start"];

/**
 * Tab completion in the shell completes folder names with a trailing separator, so `wag feature/testA/ repo1/`
 * is what you get for typing two tabs in the projects folder. Dropping it makes those names the ones wag means.
 */
const trimSlashes = (a) => a.replace(/[\\/]+$/, "") || a;

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
  const [feature, ...repos] = argv.filter((a) => !a.startsWith("-") && !a.startsWith("+")).map(trimSlashes);
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
