import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const WT = join(import.meta.dirname, "..", "scripts", "wt.mjs");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Runs wt with WT_PROJECTS pointed at the sandbox. */
function wt(projects: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [WT, ...args], {
    env: { ...process.env, WT_PROJECTS: projects },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

/** A bare origin with one commit on main, and a clone of it as <projects>/app. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "wt-test-"));
  const projects = join(root, "projects");
  mkdirSync(projects);
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "a.txt"), "v1\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "init");
  const origin = join(root, "origin.git");
  git(root, "clone", "-q", "--bare", seed, origin);
  git(root, "clone", "-q", origin, join(projects, "app"));
  return { root, projects, origin, app: join(projects, "app") };
}

test("create makes a worktree on a same-named branch tracking origin, and a second call just enters it", () => {
  const s = setup();
  const r = wt(s.projects, "feature-a", "app");
  assert.equal(r.code, 0, r.err);
  const path = join(s.projects, "feature-a", "app-feature-a");
  assert.equal(r.out, path);
  assert.equal(git(path, "branch", "--show-current"), "feature-a");
  assert.equal(git(s.app, "config", "branch.feature-a.merge"), "refs/heads/feature-a");
  assert.equal(git(s.app, "config", "branch.feature-a.remote"), "origin");

  const again = wt(s.projects, "feature-a", "app");
  assert.equal(again.code, 0);
  assert.equal(again.out, path);
});

test("a plain git push from the worktree creates the same-named branch on origin", () => {
  const s = setup();
  const path = wt(s.projects, "feature-a", "app").out;
  writeFileSync(join(path, "b.txt"), "x\n");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "work");
  git(path, "push", "-q");
  assert.match(git(s.root, "ls-remote", s.origin, "refs/heads/feature-a"), /refs\/heads\/feature-a$/);
});

test("an existing origin branch is picked up, not recreated from main", () => {
  const s = setup();
  const other = join(s.root, "other");
  git(s.root, "clone", "-q", s.origin, other);
  git(other, "checkout", "-q", "-b", "feature-b");
  writeFileSync(join(other, "c.txt"), "from origin\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "remote work");
  git(other, "push", "-q", "origin", "feature-b");

  const r = wt(s.projects, "feature-b", "app");
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(r.out, "c.txt")));
});

test("invalid names are refused", () => {
  const s = setup();
  for (const bad of ["bad name", "-x", "a..b", "a~b"]) {
    const r = wt(s.projects, bad, "app");
    assert.equal(r.code, 1, bad);
    assert.match(r.err, /invalid feature name/, bad);
  }
  assert.equal(existsSync(join(s.projects, "bad name")), false);
});

test("a repo without an origin remote is refused", () => {
  const s = setup();
  git(s.app, "remote", "remove", "origin");
  const r = wt(s.projects, "feature-a", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /no "origin" remote/);
  assert.equal(existsSync(join(s.projects, "feature-a")), false);
});

test("a failed fetch is an error and leaves nothing behind", () => {
  const s = setup();
  rmSync(s.origin, { recursive: true, force: true });
  const r = wt(s.projects, "feature-a", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /fetch/);
  assert.equal(existsSync(join(s.projects, "feature-a")), false);
});

test("a local branch that diverged from origin is refused", () => {
  const s = setup();
  const path = wt(s.projects, "feature-a", "app").out;
  writeFileSync(join(path, "local.txt"), "local\n");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "local only");
  assert.equal(wt(s.projects, "feature-a", "app", "--rm").code, 0);

  const other = join(s.root, "other");
  git(s.root, "clone", "-q", s.origin, other);
  git(other, "checkout", "-q", "-b", "feature-a", "origin/main");
  writeFileSync(join(other, "remote.txt"), "remote\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "remote only");
  git(other, "push", "-q", "origin", "feature-a");

  const r = wt(s.projects, "feature-a", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /diverged/);
  assert.equal(existsSync(join(s.projects, "feature-a", "app-feature-a")), false);
});

test("a branch already checked out in the main checkout is refused", () => {
  const s = setup();
  git(s.app, "checkout", "-q", "-b", "feature-a");
  const r = wt(s.projects, "feature-a", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /already checked out/);
});

test("remove refuses uncommitted changes unless forced, and keeps the branch", () => {
  const s = setup();
  const path = wt(s.projects, "feature-a", "app").out;
  writeFileSync(join(path, "dirty.txt"), "x\n");
  const refused = wt(s.projects, "feature-a", "app", "--rm");
  assert.equal(refused.code, 1);
  assert.match(refused.err, /uncommitted changes/);

  const forced = wt(s.projects, "feature-a", "app", "--rm", "--force");
  assert.equal(forced.code, 0, forced.err);
  assert.equal(existsSync(path), false);
  assert.match(git(s.app, "branch", "--list", "feature-a"), /feature-a/);
});

test("bad usage prints usage and exits 1", () => {
  const s = setup();
  assert.equal(wt(s.projects, "feature-a", "app", "--force").code, 1);
  assert.equal(wt(s.projects, "feature-a", "--rm").code, 1);
  assert.equal(wt(s.projects, "a", "b", "c").code, 1);
});
