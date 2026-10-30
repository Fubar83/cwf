import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

const WAG = join(import.meta.dirname, "..", "bin", "wag.js");
const slash = (p) => p.replaceAll("\\", "/");

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A config value, "" when the key is not set. */
const conf = (cwd, key) => {
  try {
    return git(cwd, "config", "--get", key);
  } catch {
    return "";
  }
};

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
    wt: (repo = "app", feature = "feature-a") => join(projects, feature.replaceAll("/", "-"), repo),
  };
}

// ───────────────────────── worktrees and branches ─────────────────────────

test("create makes a worktree on a same-named branch, with no upstream until it is pushed", () => {
  const s = setup();
  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, s.wt());
  assert.equal(git(r.out, "branch", "--show-current"), "feature-a");
  assert.match(r.err, /not on origin yet/);
  // The branch is not on origin yet, so it has no upstream: one naming a branch origin does not have is
  // what makes every git status in the worktree warn. The push config is what sends a plain push there.
  assert.equal(conf(s.main(), "branch.feature-a.merge"), "");
  assert.equal(conf(s.main(), "push.autoSetupRemote"), "true");
  assert.doesNotMatch(git(r.out, "status"), /upstream is gone/);
  assert.match(git(r.out, "status", "-sb"), /^## feature-a$/m);

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
    assert.equal(conf(s.main(repo), "branch.feature-a.merge"), "");
  }
  // Adding a repo later keeps the existing one
  assert.equal(s.wag("feature-a", "app").out, s.wt("app"));
});

test("a plain git push creates the branch on origin and sets the upstream, and works again after that", () => {
  const s = setup();
  const path = s.wag("feature-a", "app").out;
  const commit = (name) => {
    writeFileSync(join(path, name), "x\n");
    git(path, "add", "-A");
    git(path, "commit", "-q", "-m", name);
  };
  commit("b.txt");
  git(path, "push", "-q");
  assert.match(git(s.root, "ls-remote", s.origin(), "refs/heads/feature-a"), /refs\/heads\/feature-a$/);
  assert.equal(conf(s.main(), "branch.feature-a.remote"), "origin");
  assert.equal(conf(s.main(), "branch.feature-a.merge"), "refs/heads/feature-a");

  commit("c.txt"); // and later on, with the upstream in place
  git(path, "push", "-q");
  assert.equal(git(path, "rev-parse", "HEAD"), git(path, "rev-parse", "refs/remotes/origin/feature-a"));
});

test("an upstream that is gone is dropped the next time the feature is opened", () => {
  const s = setup();
  const path = s.wag("feature-a", "app").out;
  // What an older wag left behind: an upstream for a branch it never pushed.
  git(s.main(), "config", "branch.feature-a.remote", "origin");
  git(s.main(), "config", "branch.feature-a.merge", "refs/heads/feature-a");
  assert.match(git(path, "status"), /upstream is gone/);

  assert.equal(s.wag("feature-a", "app").code, 0);
  assert.equal(conf(s.main(), "branch.feature-a.merge"), "");
  assert.doesNotMatch(git(path, "status"), /upstream is gone/);
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
  // It is on origin, so the upstream is set right away.
  assert.match(r.err, /tracking origin\/feature-b/);
  assert.equal(conf(s.main(), "branch.feature-b.merge"), "refs/heads/feature-b");
});

test("listing shows features and their worktrees", () => {
  const s = setup("", ["app", "web"]);
  s.wag("feature-a", "app", "web");
  const all = s.wag();
  assert.equal(all.code, 0);
  assert.match(all.out, /^feature-a\n\s+app\s+.*\n\s+web\s+/);
  assert.match(s.wag("feature-a").out, /feature-a[\\/]web$/m);
  assert.match(s.wag("nope").out, /No worktrees for nope/);
});

test("invalid names are refused and leave nothing behind", () => {
  const s = setup();
  // Slashes are fine in a feature name, but only where git would take them in a branch name.
  for (const bad of ["bad name", "a..b", "a~b", "feat//login", "feat/.login", "/login"]) {
    const r = s.wag(bad, "app");
    assert.equal(r.code, 1, bad);
    assert.match(r.err, /invalid feature name/, bad);
  }
  assert.equal(existsSync(join(s.projects, "bad name")), false);
  // A repo is one folder, so it never takes a slash.
  const repo = s.wag("feature-a", "app/sub");
  assert.equal(repo.code, 1);
  assert.match(repo.err, /invalid repo name "app\/sub"/);
});

test("a feature can be a path: one flat folder, with each worktree named after its repo", () => {
  const s = setup("", ["app", "web"]);
  const r = s.wag("feature/abc123", "app", "web");
  assert.equal(r.code, 0, r.err);
  // Slashes become dashes in the folder name; the branch keeps them.
  assert.equal(r.out, join(s.projects, "feature-abc123"));
  for (const repo of ["app", "web"]) {
    const wt = join(s.projects, "feature-abc123", repo);
    assert.ok(existsSync(join(wt, ".git")), `${repo} worktree`);
    assert.equal(git(wt, "branch", "--show-current"), "feature/abc123");
  }
  assert.match(r.err, /Created feature-abc123\/app on branch feature\/abc123/);
  // Listed under its branch, which is the name the folder cannot spell.
  assert.match(s.wag().out, /^feature\/abc123$/m);
  assert.match(s.wag("feature/abc123").out, /feature-abc123[\\/]app$/m);
  // The main checkouts are not mistaken for feature folders.
  assert.doesNotMatch(s.wag().out, /^(app|web)$/m);
});

test("a feature whose folder name another feature already uses is refused", () => {
  const s = setup();
  s.wag("feature/abc123", "app");
  const r = s.wag("feature-abc123", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /already holds feature\/abc123, which uses the same folder name/);
});

test("a repository with a nested repository in it is not mistaken for a feature", () => {
  const s = setup();
  mkdirSync(join(s.main(), "node_modules", "pkg"), { recursive: true });
  git(join(s.main(), "node_modules", "pkg"), "init", "-q");
  s.wag("feature-a", "app");
  assert.match(s.wag().out, /^feature-a$/m);
  assert.doesNotMatch(s.wag().out, /^app$/m);
});

test("a trailing slash from tab completion is dropped, on the feature and on each repo", () => {
  const s = setup("", ["app", "web"]);
  const r = s.wag("feature/testA/", "app/", "web/");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, join(s.projects, "feature-testA"));
  assert.ok(existsSync(join(s.projects, "feature-testA", "app", ".git")));
  // Still the same feature when it is opened again without the slashes.
  assert.equal(s.wag("feature/testA", "app").out, join(s.projects, "feature-testA", "app"));
  // And a repo named twice is still a duplicate once the slashes are gone.
  assert.equal(s.wag("feature-b", "app/", "app").code, 1);
});

test("removing a feature takes its folder with it, and leaves the other features alone", () => {
  const s = setup();
  s.wag("a/b/c", "app");
  assert.ok(existsSync(join(s.projects, "a-b-c", "app", ".git")));
  assert.equal(s.wag("a/b/c", "--rm").code, 0);
  assert.equal(existsSync(join(s.projects, "a-b-c")), false);

  s.wag("keep/one", "app");
  s.wag("keep/two", "app");
  assert.equal(s.wag("keep/one", "--rm").code, 0);
  assert.equal(existsSync(join(s.projects, "keep-two", "app")), true);
  assert.equal(existsSync(join(s.projects, "keep-one")), false);
});

test("features: a folder under projects keeps the main checkouts and the features apart", () => {
  const s = setup("features: _features\n", ["app", "web"]);
  assert.match(s.wag().out, /No features yet/); // the folder is made with the first worktree
  const r = s.wag("feature/testA", "app", "web");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, join(s.projects, "_features", "feature-testA"));
  assert.ok(existsSync(join(s.projects, "_features", "feature-testA", "app", ".git")));
  // The main checkouts are untouched and are not mistaken for features.
  assert.ok(existsSync(join(s.main("app"), ".git")));
  assert.match(s.wag().out, /^feature\/testA$/m);
  assert.doesNotMatch(s.wag().out, /^(app|web|_features)$/m);
  // Removing takes the feature folder, and leaves the features folder itself.
  assert.equal(s.wag("feature/testA", "--rm").code, 0);
  assert.equal(existsSync(join(s.projects, "_features", "feature-testA")), false);
  assert.equal(existsSync(join(s.projects, "_features")), true);
});

test("features: only a folder inside projects, and not one that is a repository", () => {
  const s = setup("", ["app"]);
  const setFeatures = (value) => writeFileSync(s.configFile, `projects: '${slash(s.projects)}'\nfeatures: '${value}'\n`);

  // Anything that would land outside projects is a config error, named as one.
  for (const outside of ["../elsewhere", "~/elsewhere", slash(join(s.root, "work")), "/abs"]) {
    setFeatures(outside);
    const r = s.wag("feature-a", "app");
    assert.equal(r.code, 1, outside);
    assert.match(r.err, /config features: must be a folder inside projects/, outside);
  }
  // A folder deeper inside projects is fine.
  setFeatures("work/features");
  const ok = s.wag("feature-a", "app");
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, join(s.projects, "work", "features", "feature-a", "app"));

  // And the folder cannot be a repository, which is what naming a repo would do.
  setFeatures("app");
  const bad = s.wag("feature-b", "app");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /is a repository, so feature folders cannot go in it/);
});

test("a feature starting with a repo name is fine: flattening keeps it out of the repository", () => {
  const s = setup();
  // app/thing is the folder app-thing, beside the app checkout rather than inside it.
  const r = s.wag("app/thing", "app");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, join(s.projects, "app-thing", "app"));
  assert.equal(existsSync(join(s.projects, "app", "thing")), false);
  assert.equal(git(r.out, "branch", "--show-current"), "app/thing");
  // Only a name that lands on the repo folder itself is refused, which "wag app app" already covers.
  assert.match(s.wag("app", "app").err, /is a repository/);
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

test("a main checkout on another branch is put back on the default branch, freeing the feature's branch", () => {
  const s = setup();
  git(s.main(), "checkout", "-q", "-b", "feature-a");
  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /main checkout switched from feature-a to main/);
  assert.equal(git(s.main(), "branch", "--show-current"), "main");
  assert.equal(git(s.wt(), "branch", "--show-current"), "feature-a");

  git(s.main(), "checkout", "-q", "-b", "unrelated"); // also from a branch the feature has nothing to do with
  assert.match(s.wag("feature-b", "app").err, /main checkout switched from unrelated to main/);
  assert.equal(git(s.main(), "branch", "--show-current"), "main");
});

test("a main checkout with uncommitted changes is left on its branch, so its branch is still refused", () => {
  const s = setup();
  git(s.main(), "checkout", "-q", "-b", "feature-a");
  writeFileSync(join(s.main(), "a.txt"), "work in progress\n");
  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /uncommitted changes, so it was left there/);
  assert.match(r.err, /already checked out/);
  assert.equal(git(s.main(), "branch", "--show-current"), "feature-a");
  assert.equal(existsSync(s.wt()), false);
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
      - exit 4
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

// ───────────────────────── repo hooks ─────────────────────────

test("hook steps are bash command lines, run in the worktree, with the WAG_* variables", () => {
  const home = mkdtempSync(join(tmpdir(), "wag-home-"));
  writeFileSync(join(home, "appsettings.Local.json"), '{"local":true}\n');
  const s = setup(`hooks:
  repo:
    create:
      - mkdir -p config && cp '${slash(join(home, "appsettings.Local.json"))}' config/appsettings.Local.json
repos:
  app:
    create:
      - cp "$WAG_MAIN/.env" .env
      - echo "$WAG_FEATURE $WAG_REPO $WAG_BRANCH in $(basename "$PWD")" > ran.txt
`);
  writeFileSync(join(s.main(), ".env"), "SECRET=1\n"); // untracked file in the main checkout

  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(r.out, ".env"), "utf8"), "SECRET=1\n");
  assert.equal(readFileSync(join(r.out, "config", "appsettings.Local.json"), "utf8"), '{"local":true}\n');
  assert.equal(readFileSync(join(r.out, "ran.txt"), "utf8").trim(), "feature-a app feature-a in app");
  // Nothing is excluded for you any more: what a hook brings in is simply untracked.
  assert.match(git(r.out, "status", "--porcelain"), /\?\? \.env/);
});

test("a step whose first word is a file next to the config is run as a script, with its arguments", () => {
  const s = setup(`hooks:
  repo:
    create:
      - setup.sh --verbose "two words"
`);
  // No execute bit and no shebang: wag runs it with bash.
  writeFileSync(join(dirname(s.configFile), "setup.sh"), 'echo "args: $*" > from-script.txt\n');
  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(r.out, "from-script.txt"), "utf8").trim(), "args: --verbose two words");
  assert.match(r.err, /script next to config\.yaml/);

  // A name that is not a file next to the config stays an ordinary command.
  const plain = setup(`hooks:
  repo:
    create:
      - echo plain > from-command.txt
`);
  const ok = plain.wag("feature-a", "app");
  assert.equal(ok.code, 0, ok.err);
  assert.equal(readFileSync(join(ok.out, "from-command.txt"), "utf8").trim(), "plain");
  assert.doesNotMatch(ok.err, /script next to/);
});

test("a hook step's output never reaches stdout", () => {
  const s = setup(`repos:
  app:
    create:
      - echo noise
`);
  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, s.wt(), "stdout must be only the path");
  assert.match(r.err, /noise/);
});

test("a failing create hook rolls everything back", () => {
  const s = setup(`repos:
  app:
    create:
      - exit 3
`);
  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 1);
  assert.match(r.err, /exit code 3/);
  assert.equal(existsSync(join(s.projects, "feature-a")), false);
  assert.equal(git(s.main(), "branch", "--list", "feature-a"), "");
});

test("steps run with a bash that sees ordinary paths, and WAG_BASH picks which one", () => {
  const s = setup(`hooks:
  repo:
    create:
      - test -f "$WAG_MAIN/a.txt" && echo saw-it > proof.txt
`);
  // The point of this on Windows: "bash" on PATH is usually the WSL launcher, where a path like
  // C:/Users/... does not exist, so a step reaching into the main checkout has to fail there.
  const r = s.wag("feature-a", "app");
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(r.out, "proof.txt"), "utf8").trim(), "saw-it");

  // WAG_BASH overrides the search, and a bad one is reported as what it is.
  const bogus = spawnSync(process.execPath, [WAG, "feature-b", "app"], {
    env: { ...process.env, WAG_CONFIG: s.configFile, WAG_BASH: join(s.root, "no-such-bash") },
    encoding: "utf8",
  });
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /could not start with .*no-such-bash/);
});

test("a multi-line step is a bash script, and a step may be allowed to fail", () => {
  const s = setup(`hooks:
  repo:
    create:
      - cp "$WAG_MAIN/.env" .env 2>/dev/null || true
      - |
        if [ -f a.txt ]; then echo "found a.txt" > checked.txt
        else echo missing > checked.txt
        fi
`);
  const r = s.wag("feature-a", "app"); // there is no .env in the main checkout
  assert.equal(r.code, 0, r.err);
  assert.equal(existsSync(join(r.out, ".env")), false);
  assert.equal(readFileSync(join(r.out, "checked.txt"), "utf8").trim(), "found a.txt");
});

test("a failing remove hook stops the removal unless forced", () => {
  const s = setup(`repos:
  app:
    remove:
      - exit 2
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

// ───────────────────────── feature hooks ─────────────────────────

// The worktrees are counted with grep, not `wc -w`: BSD wc pads its number with spaces and GNU wc does not,
// so the same step would print different things on macOS and on Linux.
test("feature create hooks run once, in the feature folder, after every repo's own", () => {
  const s = setup(`hooks:
  repo:
    create:
      - echo "repo $WAG_REPO" >> ../order.txt
  feature:
    create:
      - echo "feature $WAG_FEATURE in $(basename "$PWD") with $(echo $WAG_REPOS) and $(printf '%s\\n' "$WAG_WORKTREES" | grep -c .) worktrees" >> order.txt
`, ["app", "web", "docs"]);
  const order = join(s.projects, "feature-a", "order.txt");

  const r = s.wag("feature-a", "app", "web");
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(order, "utf8").trim().split(/\r?\n/).join("|"),
    "repo app|repo web|feature feature-a in feature-a with app web and 2 worktrees");
  assert.match(r.err, /feature create hooks for feature-a:/);
  assert.equal(existsSync(join(s.projects, "feature-a", "app", "order.txt")), false, "runs in the feature folder");

  // Opening the feature again creates nothing, so neither level of hooks runs again.
  assert.equal(s.wag("feature-a", "app", "web").code, 0);
  assert.equal(readFileSync(order, "utf8").trim().split(/\r?\n/).length, 3);

  // Adding a repo is that repo appearing, not the feature: its own hooks run, the feature's do not.
  assert.equal(s.wag("feature-a", "docs").code, 0);
  const lines = readFileSync(order, "utf8").trim().split(/\r?\n/);
  assert.deepEqual(lines.slice(3), ["repo docs"]);
});

test("feature remove hooks run once, before the last worktree goes", () => {
  const s = setup(`hooks:
  feature:
    remove:
      - echo "$(echo $WAG_REPOS) with $(ls) repo=\${WAG_REPO-unset}" >> ../removed.txt
`, ["app", "web"]);
  const removed = join(s.projects, "removed.txt");
  s.wag("feature-a", "app", "web");

  // One repo of two is not the feature going away.
  assert.equal(s.wag("feature-a", "web", "--rm").code, 0);
  assert.equal(existsSync(removed), false);

  // The rest of it is, and the hook still sees the worktrees. WAG_REPO is never set at this level, not even
  // here, where the feature is down to one repo: the repos are a list, however many of them there are.
  assert.equal(s.wag("feature-a", "--rm").code, 0);
  assert.equal(readFileSync(removed, "utf8").trim(), "app with app repo=unset");
  assert.equal(existsSync(join(s.projects, "feature-a")), false);
});

test("a failing feature create hook rolls every worktree back and says what it left", () => {
  const s = setup(`hooks:
  feature:
    create:
      - echo note > NOTES.md
      - exit 4
`, ["app", "web"]);
  const r = s.wag("feature-a", "app", "web");
  assert.equal(r.code, 1);
  assert.match(r.err, /exit code 4/);
  assert.match(r.err, /Rolled back 2 worktree\(s\)/);
  for (const repo of ["app", "web"]) {
    assert.equal(existsSync(join(s.projects, "feature-a", repo)), false);
    assert.equal(git(s.main(repo), "branch", "--list", "feature-a"), "");
  }
  // The folder is kept, because the hook had already written something into it.
  assert.equal(readFileSync(join(s.projects, "feature-a", "NOTES.md"), "utf8").trim(), "note");
  assert.match(r.err, /still holds files a hook made/);
});

test("examples/jira-notes.sh writes notes for a branch that ends in a Jira key", () => {
  const s = setup(`hooks:
  feature:
    create:
      - jira-notes.sh https://jira.example.com/
`, ["app", "web"]);
  copyFileSync(join(import.meta.dirname, "..", "examples", "jira-notes.sh"), join(dirname(s.configFile), "jira-notes.sh"));

  const r = s.wag("feature/vfs-1234", "app", "web");
  assert.equal(r.code, 0, r.err);
  const notes = readFileSync(join(s.projects, "feature-vfs-1234", "NOTES.md"), "utf8");
  assert.match(notes, /^# VFS-1234$/m);
  assert.match(notes, /https:\/\/jira\.example\.com\/browse\/VFS-1234/);
  assert.match(notes, /feature\/vfs-1234/);
  assert.match(notes, /app web/);

  // Notes already written in are never overwritten.
  writeFileSync(join(s.projects, "feature-vfs-1234", "NOTES.md"), "mine\n");
  assert.equal(s.wag("feature/vfs-1234", "--rm").code, 0);
  assert.equal(s.wag("feature/vfs-1234", "app").code, 0);
  assert.equal(readFileSync(join(s.projects, "feature-vfs-1234", "NOTES.md"), "utf8"), "mine\n");

  // A branch with no key at the end is fine: no notes, and the worktree stays.
  const plain = s.wag("release-x", "app");
  assert.equal(plain.code, 0, plain.err);
  assert.equal(existsSync(join(s.projects, "release-x", "NOTES.md")), false);
});

// ───────────────────────── start profiles ─────────────────────────

const RECORD = `node -e "require('fs').writeFileSync(process.env.OUT, [process.env.WAG_FEATURE, process.env.WAG_REPOS.split('\\n').join(','), process.cwd()].join(';'))"`;

test("autostart runs once per call for the whole feature, in the feature folder", () => {
  const s = setup(`start:
  record:
    - ${RECORD}
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
    - ${RECORD}
  other:
    - node -e "require('fs').writeFileSync(process.env.OUT, 'other')"
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
    - exit 5
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
    // The old step syntax is gone, and the error says so rather than just "must be a string".
    [`repos:\n  app:\n    create:\n      - run: npm ci\n`, /repos\.app\.create\[0\]: must be a command, as a string \(a mapping: "run:" and "copy:" are gone/],
    [`start:\n  tmux:\n    - copy: .env\n`, /start\.tmux\[0\]: must be a command, as a string/],
    [`hooks:\n  repo:\n    create: npm ci\n`, /hooks\.repo\.create: must be a list of commands/],
    [`hooks:\n  feature:\n    create:\n      - ''\n`, /hooks\.feature\.create\[0\]: must be a command, as a string/],
    // Steps used to sit straight under hooks, where they meant every repo. The error says where they go now.
    [`hooks:\n  create:\n    - npm ci\n`, /hooks\.create: hooks now name their level.*hooks\.repo\.create \(for every repo\)/],
    [`hooks:\n  worktree:\n    create:\n      - npm ci\n`, /hooks: unknown key "worktree" \(allowed: repo, feature\)/],
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

/** Every step in a parsed config, from hooks, repos and start profiles. Steps are plain command strings. */
function runScripts(cfg) {
  const steps = [
    ...(cfg.hooks?.repo?.create ?? []), ...(cfg.hooks?.repo?.remove ?? []),
    ...(cfg.hooks?.feature?.create ?? []), ...(cfg.hooks?.feature?.remove ?? []),
    ...Object.values(cfg.repos ?? {}).flatMap((r) => [...(r?.create ?? []), ...(r?.remove ?? [])]),
    ...Object.values(cfg.start ?? {}).flat(),
  ];
  return steps.filter((s) => typeof s === "string").map((s) => s.replace(/\r/g, "").trimEnd());
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
  assert.equal(r.out, join(s.projects, "feature-a", "ext"));
});

test("--version prints the version from package.json", () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const r = spawnSync(process.execPath, [WAG, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), version);
});

/** Commits a change in a worktree, as the agent would. */
function commitIn(path, file, content, message) {
  writeFileSync(join(path, file), content);
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", message);
}

// ───────────────────────── git view example ─────────────────────────

/**
 * A shell for the example scripts: the system one, or Git's bash on Windows, where "sh" is usually absent
 * and "bash" on PATH is the WSL launcher. Same place wag looks, so this runs outside Git Bash too.
 */
const SH = (() => {
  if (spawnSync("sh", ["-c", "exit 0"]).status === 0) return "sh";
  if (process.platform !== "win32") return "";
  for (let d = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(); d && d !== dirname(d); d = dirname(d)) {
    for (const rel of [["bin", "bash.exe"], ["usr", "bin", "bash.exe"]]) {
      if (existsSync(join(d, ...rel))) return join(d, ...rel);
    }
  }
  return "";
})();
const hasSh = SH !== "";

test("examples/git-view.sh shows branch, files and commits of a worktree", { skip: !hasSh && "no sh on PATH" }, () => {
  const s = setup();
  const path = s.wag("feature-a", "app").out;
  commitIn(path, "csv.txt", "x\n", "Add CSV export");
  writeFileSync(join(path, "staged.txt"), "s\n");
  git(path, "add", "staged.txt");
  writeFileSync(join(path, "a.txt"), "changed\n");

  const view = join(ROOT, "examples", "git-view.sh");
  const r = spawnSync(SH, [view, "--once", path], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(out, /## feature-a.*\(not pushed yet\)/);
  assert.match(out, /^A  staged\.txt$/m);
  assert.match(out, /^ M a\.txt$/m);
  assert.match(out, /staged: 1 file changed/);
  assert.match(out, /not staged: 1 file changed/);
  assert.match(out, /Add CSV export/);

  const feature = spawnSync(SH, [view, "--once", join(s.projects, "feature-a")], { encoding: "utf8" });
  assert.match(feature.stdout.replace(/\x1b\[[0-9;]*m/g, ""), /^app$/m);
});

