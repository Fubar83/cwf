# Configuration

All of wag's configuration is one YAML file in your home folder. Nothing is needed in the repos.

## Where the file is

wag uses the first of these that applies:

1. `$WAG_CONFIG`, if set: any path you like.
2. `$XDG_CONFIG_HOME/wag/config.yaml`, if `XDG_CONFIG_HOME` is set.
3. `~/.config/wag/config.yaml`. On Windows that is `%USERPROFILE%\.config\wag\config.yaml`.

`wag --help` prints the file it uses. Without a file, wag uses `~/projects` and no hooks.
Ready-made files are in [examples/](../examples): `minimal.yaml`, `config.yaml`, `tmux-per-repo.yaml` and `tmux-switch.yaml`.

## Overview

```yaml
projects: ~/projects          # where the main checkouts are
features: _features           # a folder inside projects for them; default: in projects itself

hooks:                        # for every repo
  create: []                  # after a worktree is made
  remove: []                  # before a worktree is removed

repos:                        # per repo, by folder name
  api:
    path: ~/work/api          # optional: main checkout outside projects
    create: []
    remove: []

start:                        # start profiles, picked with +name
  hello:
    - echo "Working on $WAG_FEATURE"

autostart: [hello]            # profiles to run when no +name is given
```

Unknown keys are errors, so a typo never goes unnoticed. The error names the exact place,
for example `config repos.api.create[0]: unknown key "too" (allowed: copy, to, optional, overwrite)`.

## projects

The folder with your main checkouts. `~` is your home folder. Default: `~/projects`.

A repo is any git repository directly under `projects`, named by its folder. Use `repos.<name>.path`
for a main checkout that lives somewhere else; its worktrees still go in the feature folder.

## features

A folder inside `projects` for the feature folders, so your main checkouts and your features are not mixed
together. Left out, features go in `projects` itself, next to the main checkouts, which is what wag has
always done.

```yaml
projects: ~/projects
features: _features
```

```text
~/projects/api/                                 main checkout
~/projects/web/                                 main checkout
~/projects/_features/feature-login/api/         worktree, branch feature/login
~/projects/_features/feature-login/web/         worktree, branch feature/login
```

A feature keeps its own folder inside, with one worktree per repo:
`<features>/<feature>/<repo>`. Any name works, and so does a deeper one such as
`work/features`, as long as it stays inside `projects`: an absolute path, one starting with `~`, and
anything climbing out with `..` are all config errors, so one setting can never send worktrees off to an
unrelated part of the disk.

`repos.<name>.path` is the setting for a main checkout that lives elsewhere; it moves that checkout only,
and its worktrees still go under `features` with all the others.

The folder is created when the first worktree is, so `wag` simply says there are no features until then.
wag only ever looks for features where `features` points, so moving it leaves existing feature folders
behind: move them yourself, or remove them with `--rm` before you change the setting. A folder that is
itself a git repository cannot hold feature folders, and wag says so rather than writing into it.

## Hooks

Hooks run for one worktree at a time:

- **create** runs right after the worktree is made. If a step fails, wag rolls back everything that call created.
- **remove** runs before the worktree is removed. If a step fails, nothing is removed, unless you pass `--force`.

The steps under `hooks` run for every repo first, then the steps under `repos.<name>` for that repo.

## Steps

A step is one **bash** command line, written as a plain string. There is no key to name it and nothing else a
step can be: copying a file in is `cp`, as it would be in any script.

```yaml
hooks:
  create:
    - cp "$WAG_MAIN/.env" .env 2>/dev/null || true
    - npm ci
```

Hook steps run in the worktree; start profile steps run in the path wag prints. Either way the step's output
goes to stderr, so it never mixes with that path. A step that exits non-zero fails: a create hook rolls the
whole call back, a remove hook stops the removal. Use `|| true` for something allowed to fail, as above for
a `.env` that may not exist.

The bash is the system one on Linux and macOS, and Git Bash on Windows, which wag finds for you (see
[Windows](#windows)). One shell everywhere means one way to write a step — `$WAG_REPO`, not `%WAG_REPO%` —
and a multi-line step is an ordinary bash script:

```yaml
hooks:
  create:
    - |
      if [ -f package-lock.json ]; then npm ci
      elif [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile
      fi
```

### Script files

A step whose first word is a file **next to the config file** is run as that script, with bash, keeping any
arguments after it. So `~/.config/wag/setup.sh` is reached as `setup.sh`:

```yaml
hooks:
  create:
    - setup.sh --verbose
```

It needs no execute bit and no shebang, because wag runs `bash <the file>`. The first word has to be a bare
name: anything with a slash in it is a path like any other, taken from the folder the step runs in. wag says
which steps it took this way, so a step that is meant to be a command but happens to share a name with a file
next to your config is visible rather than silent:

```text
  $ setup.sh --verbose   (script next to config.yaml)
```

### Variables

| Variable | Value |
|---|---|
| `WAG_FEATURE` | The feature name. |
| `WAG_BRANCH` | The branch name in every repo. It is the same as the feature name. |
| `WAG_REPO` | The repo name. |
| `WAG_WORKTREE` | The worktree's full path. |
| `WAG_MAIN` | The main checkout's full path. |

Start profiles get a different set, listed in [agents.md](agents.md).

### Examples

Local secrets and settings, kept in your home folder. Nothing is excluded from git for you, so a file you
bring in shows up as untracked: add it to the repo's `.gitignore`, or to its local exclude list, if that
matters to you.

```yaml
hooks:
  create:
    - cp "$WAG_MAIN/.env" .env 2>/dev/null || true   # each repo's own local .env, if it has one
repos:
  api:
    create:
      - cp ~/secrets/api/appsettings.Development.json src/Api/appsettings.Development.json
      - cp -r ~/secrets/api/certs certs                # a whole folder
      - echo /.env >> "$(git rev-parse --git-common-dir)/info/exclude"
```

Install dependencies, and clean up containers when a worktree goes away:

```yaml
repos:
  web:
    create:
      - npm ci
  api:
    create:
      - dotnet restore
    remove:
      - docker compose down
```

## Start profiles

Start profiles open your tools. Unlike hooks, they:

- run **once per call for the whole feature**, not once per repo;
- run **every time** you call `wag <feature> <repo>...`, also when the worktrees already exist;
- run in the **printed path**: the worktree for one repo, the feature folder for several;
- only have `run` steps;
- never remove anything when they fail: wag reports the error and the worktrees stay.

| Variable | Value |
|---|---|
| `WAG_FEATURE` | The feature name. |
| `WAG_BRANCH` | The branch name, the same as the feature name. |
| `WAG_FEATURE_DIR` | The feature folder's full path. |
| `WAG_REPOS` | The repos named in this call, one per line. |
| `WAG_WORKTREES` | Their worktree paths, one per line, in the same order. |
| `WAG_REPO`, `WAG_WORKTREE` | Also set when the call names exactly one repo. |

Pick profiles per call with `+name`, which can be repeated: `wag feature-a api web +tmux +notes`.
Without `+name`, the profiles in `autostart` run. `--no-start` runs none.

```yaml
start:
  code:
    - code "$WAG_FEATURE_DIR"     # open the feature folder in VS Code
  notes:
    - echo "Notes for $WAG_FEATURE" >> ~/notes/features.md
autostart: [code]
```

Examples that open an AI agent and a live git view in tmux are in [tmux.md](tmux.md); more about agents in [agents.md](agents.md).

## Windows

wag itself runs on Windows, Linux and macOS. Two things differ on Windows:

- Steps run in **bash**, which on Windows means **Git Bash**. wag finds it next to the `git` it already needs,
  so there is nothing to put on PATH: Git for Windows keeps `bash.exe` in `bin`, beside the folders that
  `git --exec-path` points into.

  wag deliberately does **not** use whatever `bash` is on PATH there. On a default Windows install that name
  is `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`, the launcher for the Windows Subsystem for Linux. That
  is a Linux bash: `C:/Users/you/...` does not exist inside it and Windows programs are not on its PATH, so a
  step that copies a file or runs `node` fails with a puzzling `No such file or directory`. Set `WAG_BASH` to
  a `bash.exe` to choose a different one on purpose (MSYS2, Cygwin, or indeed a WSL bash).

  A step is written the same way on every platform: `$WAG_FEATURE`, `cp`, `&&`. A config that drives tmux,
  such as the tmux examples, still belongs in WSL, Linux or macOS, because of tmux rather than the shell.
- Paths in the config can use `/` or `\`. `~` means `%USERPROFILE%`.

[minimal.yaml](../examples/minimal.yaml) works on every platform.
