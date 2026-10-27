import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

const WAG = join(import.meta.dirname, "..", "bin", "wag.js");
const slash = (p) => p.replaceAll("\\", "/");

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * For each repo: a bare origin with one commit on main, cloned as <projects>/<repo>.
 * `config` is extra YAML appended after the projects line.
 */
function setup(config = "", repos = ["app"]) {
  const root = mkdtempSync(join(tmpdir(), "wag-test-"));
  const projects = join(root, "projects");
  mkdirSync(projects);
  for (const repo of repos) {
    const seed = join(root, "seed", repo);
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "a.txt"), "v1\n");
    writeFileSync(join(seed, "tracked.json"), "{}\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "init");
    git(root, "clone", "-q", "--bare", seed, join(root, `${repo}.git`));
    git(root, "clone", "-q", join(root, `${repo}.git`), join(projects, repo));
  }
  const configFile = join(root, "config.yaml");
  writeFileSync(configFile, `projects: '${slash(projects)}'\n${config}`);
  const wag = (...args) => {
    const r = spawnSync(process.execPath, [WAG, ...args], {
      env: { ...process.env, WAG_CONFIG: configFile },
      encoding: "utf8",
    });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  return {
    root,
    projects,
    configFile,
    wag,
    origin: (repo = "app") => join(root, `${repo}.git`),
    main: (repo = "app") => join(projects, repo),
    wt: (repo = "app", feature = "feature-a") => join(projects, feature, `${repo}-${feature}`),
  };
}

// ───────────────────────── worktrees and branches ─────────────────────────

test("create makes a worktree on a same-named branch tracking origin; a second call just prints the path", () => {
  const s = setup();
  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, s.wt());
  assert.equal(git(r.out, "branch", "--show-current"), "feature-a");
  assert.equal(git(s.main(), "config", "branch.feature-a.remote"), "origin");
  assert.equal(git(s.main(), "config", "branch.feature-a.merge"), "refs/heads/feature-a");

  const again = s.wag("feature-a", "app");
  assert.equal(again.code, 0);
  assert.equal(again.out, s.wt());
});

test("several repos share the feature folder and branch name; stdout is the feature folder", () => {
  const s = setup("", ["app", "web"]);
  const r = s.wag("feature-a", "app", "web");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, join(s.projects, "feature-a"));
  for (const repo of ["app", "web"]) {
    assert.equal(git(s.wt(repo), "branch", "--show-current"), "feature-a");
    assert.equal(git(s.main(repo), "config", "branch.feature-a.merge"), "refs/heads/feature-a");
  }
  // Adding a repo later keeps the existing one
  assert.equal(s.wag("feature-a", "app").out, s.wt("app"));
});

test("a plain git push from the worktree creates the same-named branch on origin", () => {
  const s = setup();
  const path = s.wag("feature-a", "app").out;
  writeFileSync(join(path, "b.txt"), "x\n");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "work");
  git(path, "push", "-q");
  assert.match(git(s.root, "ls-remote", s.origin(), "refs/heads/feature-a"), /refs\/heads\/feature-a$/);
});

test("an existing origin branch is picked up, not recreated from main", () => {
  const s = setup();
  const other = join(s.root, "other");
  git(s.root, "clone", "-q", s.origin(), other);
  git(other, "checkout", "-q", "-b", "feature-b");
  writeFileSync(join(other, "c.txt"), "from origin\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "remote work");
  git(other, "push", "-q", "origin", "feature-b");

  const r = s.wag("feature-b", "app");
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(r.out, "c.txt")));
});

test("listing shows features and their worktrees", () => {
  const s = setup("", ["app", "web"]);
  s.wag("feature-a", "app", "web");
  const all = s.wag();
  assert.equal(all.code, 0);
  assert.match(all.out, /^feature-a\n\s+app\s+.*\n\s+web\s+/);
  assert.match(s.wag("feature-a").out, /web-feature-a/);
  assert.match(s.wag("nope").out, /No worktrees for nope/);
});

test("invalid names are refused and leave nothing behind", () => {
  const s = setup();
  for (const bad of ["bad name", "a..b", "a~b", "feat/login"]) {
    const r = s.wag(bad, "app");
    assert.equal(r.code, 1, bad);
    assert.match(r.err, /invalid feature name/, bad);
  }
  assert.equal(existsSync(join(s.projects, "bad name")), false);
});

test("a feature named like a repository is refused", () => {
  const s = setup();
  const r = s.wag("app", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /is a repository/);
});

test("a repo without an origin remote is refused", () => {
  const s = setup();
  git(s.main(), "remote", "remove", "origin");
  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /no "origin" remote/);
  assert.equal(existsSync(join(s.projects, "feature-a")), false);
});

test("a failed fetch is an error and leaves nothing behind", () => {
  const s = setup();
  rmSync(s.origin(), { recursive: true, force: true });
  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /fetch/);
  assert.equal(existsSync(join(s.projects, "feature-a")), false);
});

test("a local branch that diverged from origin is refused", () => {
  const s = setup();
  const path = s.wag("feature-a", "app").out;
  writeFileSync(join(path, "local.txt"), "local\n");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "local only");
  assert.equal(s.wag("feature-a", "app", "--rm").code, 0);

  const other = join(s.root, "other");
  git(s.root, "clone", "-q", s.origin(), other);
  git(other, "checkout", "-q", "-b", "feature-a", "origin/main");
  writeFileSync(join(other, "remote.txt"), "remote\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "remote only");
  git(other, "push", "-q", "origin", "feature-a");

  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /diverged/);
  assert.equal(existsSync(s.wt()), false);
});

test("a branch already checked out in the main checkout is refused", () => {
  const s = setup();
  git(s.main(), "checkout", "-q", "-b", "feature-a");
  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /already checked out/);
});

test("creating several repos is all or nothing: a bad repo stops before anything is created", () => {
  const s = setup("", ["app", "web"]);
  git(s.main("web"), "remote", "remove", "origin");
  const r = s.wag("feature-a", "app", "web");
  assert.equal(r.code, 1);
  assert.match(r.err, /web has no "origin"/);
  assert.equal(existsSync(join(s.projects, "feature-a")), false);
  assert.equal(git(s.main("app"), "branch", "--list", "feature-a"), "");
});

test("creating several repos is all or nothing: a failing hook in the second repo rolls back the first", () => {
  const s = setup(`repos:
  web:
    create:
      - run: node -e "process.exit(4)"
`, ["app", "web"]);
  const r = s.wag("feature-a", "app", "web");
  assert.equal(r.code, 1);
  assert.match(r.err, /exit code 4/);
  assert.match(r.err, /Rolled back 1 worktree/);
  assert.equal(existsSync(join(s.projects, "feature-a")), false);
  for (const repo of ["app", "web"]) {
    assert.equal(git(s.main(repo), "branch", "--list", "feature-a"), "", repo);
    assert.doesNotMatch(git(s.main(repo), "worktree", "list"), /feature-a/, repo);
  }
});

test("remove refuses uncommitted changes unless forced, and keeps the branch", () => {
  const s = setup();
  const path = s.wag("feature-a", "app").out;
  writeFileSync(join(path, "dirty.txt"), "x\n");
  const refused = s.wag("feature-a", "app", "--rm");
  assert.equal(refused.code, 1);
  assert.match(refused.err, /uncommitted changes/);

  const forced = s.wag("feature-a", "app", "--rm", "--force");
  assert.equal(forced.code, 0, forced.err);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(join(s.projects, "feature-a")), false);
  assert.match(git(s.main(), "branch", "--list", "feature-a"), /feature-a/);
});

test("removing a whole feature checks every worktree first", () => {
  const s = setup("", ["app", "web"]);
  s.wag("feature-a", "app", "web");
  writeFileSync(join(s.wt("web"), "dirty.txt"), "x\n");
  const refused = s.wag("feature-a", "--rm");
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Nothing was removed/);
  assert.ok(existsSync(s.wt("app")), "the clean worktree must not be removed either");

  rmSync(join(s.wt("web"), "dirty.txt"));
  const ok = s.wag("feature-a", "--rm");
  assert.equal(ok.code, 0, ok.err);
  assert.equal(existsSync(join(s.projects, "feature-a")), false);
});

test("bad usage prints usage and exits 1", () => {
  const s = setup();
  assert.equal(s.wag("feature-a", "app", "--force").code, 1);
  assert.equal(s.wag("feature-a", "app", "app").code, 1);
  assert.equal(s.wag("feature-a", "+tmux").code, 1);
  assert.equal(s.wag("feature-a", "app", "+tmux", "--no-start").code, 1);
  assert.equal(s.wag("--nope").code, 1);
});

// ───────────────────────── create and remove hooks ─────────────────────────

test("copy hooks bring local files in from your home folder or the main checkout, and keep them out of commits", () => {
  const home = mkdtempSync(join(tmpdir(), "wag-home-"));
  writeFileSync(join(home, "appsettings.Local.json"), '{"local":true}\n');
  const s = setup(`hooks:
  create:
    - copy: '${slash(join(home, "appsettings.Local.json"))}'
      to: config/appsettings.Local.json
repos:
  app:
    create:
      - copy: .env
`);
  writeFileSync(join(s.main(), ".env"), "SECRET=1\n"); // untracked file in the main checkout

  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(r.out, ".env"), "utf8"), "SECRET=1\n");
  assert.equal(readFileSync(join(r.out, "config", "appsettings.Local.json"), "utf8"), '{"local":true}\n');
  assert.equal(git(r.out, "status", "--porcelain"), "", "copied files must not show up as changes");
});

test("run hooks get WAG_* variables, and their output never reaches stdout", () => {
  const s = setup(`repos:
  app:
    create:
      - run: node -e "console.log('noise'); require('fs').writeFileSync('ran.txt', process.env.WAG_FEATURE + ' ' + process.env.WAG_REPO + ' ' + process.env.WAG_BRANCH)"
`);
  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, s.wt(), "stdout must be only the path");
  assert.match(r.err, /noise/);
  assert.equal(readFileSync(join(r.out, "ran.txt"), "utf8"), "feature-a app feature-a");
});

test("a failing create hook rolls everything back", () => {
  const s = setup(`repos:
  app:
    create:
      - run: node -e "process.exit(3)"
`);
  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /exit code 3/);
  assert.equal(existsSync(join(s.projects, "feature-a")), false);
  assert.equal(git(s.main(), "branch", "--list", "feature-a"), "");
});

test("a missing copy source fails unless it is optional", () => {
  const missing = setup(`repos:
  app:
    create:
      - copy: .env
`);
  const r = missing.wag("feature-a", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /does not exist/);
  assert.equal(existsSync(join(missing.projects, "feature-a")), false);

  const optional = setup(`repos:
  app:
    create:
      - copy: .env
        optional: true
`);
  assert.equal(optional.wag("feature-a", "app").code, 0);
});

test("copying over an existing file needs overwrite: true", () => {
  const src = mkdtempSync(join(tmpdir(), "wag-src-"));
  writeFileSync(join(src, "tracked.json"), '{"local":true}\n');
  const step = `      - copy: '${slash(join(src, "tracked.json"))}'\n`;

  const refused = setup(`repos:\n  app:\n    create:\n${step}`);
  const r = refused.wag("feature-a", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /overwrite: true/);

  const allowed = setup(`repos:\n  app:\n    create:\n${step}        overwrite: true\n`);
  const ok = allowed.wag("feature-a", "app");
  assert.equal(ok.code, 0, ok.err);
  assert.equal(readFileSync(join(ok.out, "tracked.json"), "utf8"), '{"local":true}\n');
});

test("a copy target outside the worktree is refused", () => {
  const s = setup(`repos:
  app:
    create:
      - copy: a.txt
        to: ../escape.txt
`);
  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /outside the worktree/);
});

test("a failing remove hook stops the removal unless forced", () => {
  const s = setup(`repos:
  app:
    remove:
      - run: node -e "process.exit(2)"
`);
  const path = s.wag("feature-a", "app").out;
  const refused = s.wag("feature-a", "app", "--rm");
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Nothing was removed/);
  assert.ok(existsSync(path));

  const forced = s.wag("feature-a", "app", "--rm", "--force");
  assert.equal(forced.code, 0, forced.err);
  assert.equal(existsSync(path), false);
});

// ───────────────────────── start profiles ─────────────────────────

const RECORD = `node -e "require('fs').writeFileSync(process.env.OUT, [process.env.WAG_FEATURE, process.env.WAG_REPOS.split('\\n').join(','), process.cwd()].join(';'))"`;

test("autostart runs once per call for the whole feature, in the feature folder", () => {
  const s = setup(`start:
  record:
    - run: ${RECORD}
autostart: [record]
`, ["app", "web"]);
  const out = join(s.root, "start.txt");
  process.env.OUT = out;
  const r = s.wag("feature-a", "app", "web");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, join(s.projects, "feature-a"), "stdout must be only the path");
  const [feature, repos, cwd] = readFileSync(out, "utf8").split(";");
  assert.deepEqual([feature, repos], ["feature-a", "app,web"]);
  // Compare real paths: on macOS the temp folder is behind a symlink.
  assert.equal(realpathSync(cwd), realpathSync(join(s.projects, "feature-a")));
});

test("+profile picks start profiles instead of autostart, and --no-start skips them", () => {
  const s = setup(`start:
  record:
    - run: ${RECORD}
  other:
    - run: node -e "require('fs').writeFileSync(process.env.OUT, 'other')"
autostart: [record]
`);
  const out = join(s.root, "start.txt");
  process.env.OUT = out;
  assert.equal(s.wag("feature-a", "app", "+other").code, 0);
  assert.equal(readFileSync(out, "utf8"), "other");

  rmSync(out);
  assert.equal(s.wag("feature-a", "app", "--no-start").code, 0);
  assert.equal(existsSync(out), false);
});

test("an unknown or failing start profile is an error, but the worktree stays", () => {
  const s = setup(`start:
  broken:
    - run: node -e "process.exit(5)"
`);
  const unknown = s.wag("feature-a", "app", "+nope");
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no start profile "nope" \(defined: broken\)/);
  assert.ok(existsSync(s.wt()));

  const broken = s.wag("feature-a", "app", "+broken");
  assert.equal(broken.code, 1);
  assert.match(broken.err, /exit code 5/);
  assert.ok(existsSync(s.wt()));
});

// ───────────────────────── config validation ─────────────────────────

test("config errors are reported with their location", () => {
  const cases = [
    [`repos:\n  app:\n    create:\n      - copy: .env\n        too: x\n`, /repos\.app\.create\[0\]: unknown key "too"/],
    [`start:\n  tmux:\n    - copy: .env\n`, /start\.tmux\[0\]: needs "run"/],
    [`autostart: [tmux]\n`, /autostart: must list start profiles defined under "start"/],
    [`colour: red\n`, /unknown key "colour"/],
  ];
  for (const [config, error] of cases) {
    const r = setup(config).wag("feature-a", "app");
    assert.equal(r.code, 1, config);
    assert.match(r.err, error, config);
  }
});

// ───────────────────────── examples and docs ─────────────────────────

const ROOT = join(import.meta.dirname, "..");

/** Runs `wag` (list) against a config text, with projects pointed at an empty temp folder. */
function validate(text) {
  const projects = mkdtempSync(join(tmpdir(), "wag-doc-"));
  const line = `projects: '${slash(projects)}'`;
  const config = join(projects, "config.yaml");
  writeFileSync(config, /^projects: .*$/m.test(text) ? text.replace(/^projects: .*$/m, line) : `${line}\n${text}`);
  return spawnSync(process.execPath, [WAG], { env: { ...process.env, WAG_CONFIG: config }, encoding: "utf8" });
}

const yamlBlocks = (md) => [...md.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);

/** Every run script in a parsed config, from hooks, repos and start profiles. */
function runScripts(cfg) {
  const steps = [
    ...(cfg.hooks?.create ?? []), ...(cfg.hooks?.remove ?? []),
    ...Object.values(cfg.repos ?? {}).flatMap((r) => [...(r?.create ?? []), ...(r?.remove ?? [])]),
    ...Object.values(cfg.start ?? {}).flat(),
  ];
  return steps.filter((s) => s.run).map((s) => s.run.replace(/\r/g, "").trimEnd());
}

test("every example config is valid", () => {
  const files = readdirSync(join(ROOT, "examples")).filter((f) => f.endsWith(".yaml"));
  assert.ok(files.length >= 2);
  for (const f of files) {
    const r = validate(readFileSync(join(ROOT, "examples", f), "utf8").replace(/\r/g, ""));
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.match(r.stdout, /No features yet/, f);
  }
});

test("every YAML block in the docs is a valid config", () => {
  for (const f of readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md"))) {
    yamlBlocks(readFileSync(join(ROOT, "docs", f), "utf8").replace(/\r/g, "")).forEach((block, i) => {
      const r = validate(block);
      assert.equal(r.status, 0, `${f} block ${i + 1}: ${r.stderr}`);
    });
  }
});

test("the tmux scripts in docs/tmux.md are the tested ones from examples/", () => {
  const examples = readdirSync(join(ROOT, "examples"))
    .filter((f) => f.endsWith(".yaml"))
    .flatMap((f) => runScripts(parseYaml(readFileSync(join(ROOT, "examples", f), "utf8"))));
  const docScripts = yamlBlocks(readFileSync(join(ROOT, "docs", "tmux.md"), "utf8").replace(/\r/g, ""))
    .flatMap((b) => runScripts(parseYaml(b)));
  assert.ok(docScripts.length >= 1);
  for (const s of docScripts) assert.ok(examples.includes(s), `not in examples/:\n${s}`);
});

test("a repo can live outside the projects folder via path", () => {
  const s = setup();
  const elsewhere = join(s.root, "elsewhere");
  git(s.root, "clone", "-q", s.origin(), elsewhere);
  writeFileSync(s.configFile, `projects: '${slash(s.projects)}'\nrepos:\n  ext:\n    path: '${slash(elsewhere)}'\n`);
  const r = s.wag("feature-a", "ext");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, join(s.projects, "feature-a", "ext-feature-a"));
});

test("--version prints the version from package.json", () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const r = spawnSync(process.execPath, [WAG, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), version);
});
