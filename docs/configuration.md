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
    - run: echo "Working on $WAG_FEATURE"

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
~/projects/_features/feature/login/api-login/   worktree, branch feature/login
~/projects/_features/feature/login/web-login/   worktree, branch feature/login
```

A feature keeps its own folder inside, with one worktree per repo:
`<features>/<feature>/<repo>-<feature>`. Any name works, and so does a deeper one such as
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
There are two kinds of step.

### copy

Copies a file or folder into the worktree.

| Key | Meaning |
|---|---|
| `copy` | The source. A relative path is taken from the repo's **main checkout**, so `copy: .env` brings in the main checkout's local `.env`. A path starting with `~` or an absolute path can point anywhere, such as a secrets folder in your home. |
| `to` | Where it goes, relative to the worktree. Default: the same relative path for a relative source, otherwise the source's file name. It cannot point outside the worktree. |
| `optional` | `true` skips the step when the source does not exist. Otherwise a missing source is an error. |
| `overwrite` | `true` allows replacing a file that already exists in the worktree. Otherwise that is an error. |

Copied files are added to the repo's local exclude list, so `git status` stays clean and they can never be committed.
If you overwrite a file git tracks, wag says so: that file will show as modified.

### run

Runs a command in the worktree, with your system shell: `sh` on Linux and macOS, `cmd.exe` on Windows.
The command's output goes to stderr, so it never mixes with the path wag prints.

| Variable | Value |
|---|---|
| `WAG_FEATURE` | The feature name. |
| `WAG_BRANCH` | The branch name in every repo. It is the same as the feature name. |
| `WAG_REPO` | The repo name. |
| `WAG_WORKTREE` | The worktree's full path. |
| `WAG_MAIN` | The main checkout's full path. |

On Windows, write variables the `cmd.exe` way, as `%WAG_FEATURE%`.

### Examples

Local secrets and settings, kept in your home folder:

```yaml
hooks:
  create:
    - copy: .env                       # each repo's own local .env, if it has one
      optional: true
repos:
  api:
    create:
      - copy: ~/secrets/api/appsettings.Development.json
        to: src/Api/appsettings.Development.json
      - copy: ~/secrets/api/certs      # a whole folder
        to: certs
```

Install dependencies, and clean up containers when a worktree goes away:

```yaml
repos:
  web:
    create:
      - run: npm ci
  api:
    create:
      - run: dotnet restore
    remove:
      - run: docker compose down
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
    - run: code "$WAG_FEATURE_DIR"     # open the feature folder in VS Code
  notes:
    - run: echo "Notes for $WAG_FEATURE" >> ~/notes/features.md
autostart: [code]
```

Examples that open an AI agent and a live git view in tmux are in [tmux.md](tmux.md); more about agents in [agents.md](agents.md).

## Windows

wag itself runs on Windows, Linux and macOS. Two things differ on Windows:

- `run` steps use `cmd.exe`, so use `%WAG_FEATURE%` and Windows commands there. A config written for `sh`,
  such as the tmux examples, belongs in WSL, Linux or macOS.
- Paths in the config can use `/` or `\`. `~` means `%USERPROFILE%`.

[minimal.yaml](../examples/minimal.yaml) works on every platform.
