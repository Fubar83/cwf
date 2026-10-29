# Using wag

wag gives each feature its own folder, with one git worktree per repo you work on, all on a branch with
the feature's name. Your main checkouts are left alone, so you can work on several features side by side.

## The layout

```text
~/projects/
├── api/                          main checkout of api, left alone
├── web/                          main checkout of web
└── feature-a/                    the feature folder
    ├── api/                      worktree of api, branch feature-a, pushes to origin/feature-a
    └── web/                      worktree of web, branch feature-a, pushes to origin/feature-a
```

- **Main checkouts** are the normal clones, directly under `projects` (or wherever a repo's `path` says).
  Creating a worktree puts a main checkout that sits on another branch back on origin's default branch,
  as long as it is clean; one with uncommitted changes is left alone, with a note.
- **The feature folder** is `projects/<feature>`, one flat folder per feature holding nothing but worktrees.
  A feature whose name is a path gets its slashes turned into dashes, so `feature/abc123` is the folder
  `feature-abc123`. Set `features` in the config to collect feature folders in a folder of their own inside
  `projects` ([configuration](configuration.md#features)).
- **Each worktree** is `projects/<feature>/<repo>`, made with `git worktree`. It is named after its repo and
  nothing else, because the folder it sits in already says which feature it belongs to. Nothing is copied:
  git shares the repository between the main checkout and its worktrees.
- **The branch** is `<feature>` in every repo. A plain `git push` from a worktree creates or updates the
  same-named branch on origin, both the first time and later on; the first push is also what sets the
  upstream. Until then the branch deliberately has none, because an upstream naming a branch that is not on
  origin yet is what makes git say "your upstream is gone" on every `git status` (it needs git 2.37, for
  `push.autoSetupRemote`, which wag sets in the repo).

### Features with slashes, and tab completion

A feature name can be anything git takes as a branch name, slashes included. The branch keeps the slashes;
the folder is the same name with dashes instead, so it stays one flat folder:

```text
$ wag feature/abc123 repo-1 repo-2

~/projects/
├── repo-1/                       main checkout of repo-1
├── repo-2/                       main checkout of repo-2
└── feature-abc123/               the feature folder for branch feature/abc123
    ├── repo-1/                   worktree of repo-1, branch feature/abc123
    └── repo-2/                   worktree of repo-2, branch feature/abc123
```

`wag` lists it under its branch, `feature/abc123`, not under the folder name: the folder name cannot be
turned back into the branch, so wag reads the branch out of the worktrees themselves.

Since slashes become dashes, `feature/abc123` and `feature-abc123` want the same folder. Whichever exists
keeps it, and the other is refused by name rather than quietly sharing it.

Tab completion in the projects folder writes the arguments for you: it adds a trailing slash to each folder
name, and wag drops it, so this is a feature name and two repos:

```bash
cd ~/projects
wag feature/abc123 repo-1/ repo-2/   # the slashes come from pressing tab; wag reads repo-1 and repo-2
```

Only what git refuses is refused: `feat//login`, `feat/.login`, a leading or trailing slash on its own, and
the usual `bad name` or `a..b`. A repo argument is always a single folder name, so `app/sub` is an error.
One thing git itself will not do is let `feature` and `feature/abc123` both be branches in the same repo;
it reports that, and wag passes the message on.

## Commands

| Command | What it does |
|---|---|
| `wag` | Lists all features and their worktrees. |
| `wag <feature>` | Lists the worktrees of one feature. |
| `wag <feature> <repo>...` | Creates the missing worktrees, runs your autostart profiles, prints the path. |
| `wag <feature> <repo>... +<profile>` | Same, but runs the named start profile(s) instead of autostart. |
| `wag <feature> <repo>... --no-start` | Same, without running any start profile. |
| `wag <feature> --rm` | Removes all of the feature's worktrees. Branches are kept. |
| `wag <feature> <repo>... --rm` | Removes only those worktrees. |
| `--force` (with `--rm`) | Removes even with uncommitted changes, and ignores failing remove hooks. |
| `wag --help` | Shows usage and which config file is used. |

A feature may be a path (`feature/abc123`); a repo is one folder name. A trailing slash on any argument,
which tab completion adds, is ignored.

The printed path is the worktree when you name one repo, and the feature folder when you name several.
Only the path goes to stdout, so `cd "$(wag feature-a api)"` works. wag never changes your shell's directory.
Everything else, including hook output, goes to stderr. The exit code is `0` on success and `1` on any error.

## A session, start to finish

This is real output, with a config that copies each repo's `.env` and runs one command for `api`
([configuration](configuration.md) explains the config).

```text
$ wag
No features yet. Create one with: wag <feature> <repo>...

$ wag feature-a api web
create hooks for feature-a/api:
  copied .env
  run: git log --oneline -1
093cdd3 Initial commit
Created feature-a/api on branch feature-a, not on origin yet; a plain git push creates origin/feature-a.
create hooks for feature-a/web:
  skip copy: ~/projects/web/.env does not exist (optional)
Created feature-a/web on branch feature-a, not on origin yet; a plain git push creates origin/feature-a.
~/projects/feature-a

$ wag
feature-a
  api                  ~/projects/feature-a/api
  web                  ~/projects/feature-a/web

$ wag feature-a api
~/projects/feature-a/api
```

The second call to `wag feature-a api` only prints the path: the worktree already exists.
Run it with a new repo, such as `wag feature-a docs`, to add that repo to the feature.

### Working in it

```bash
cd "$(wag feature-a api)"
# start your AI agent or editor here, or let a start profile do it (see agents.md)
git commit -am "Add the thing"
git push                       # goes to origin/feature-a
gh pr create --fill --draft
```

### Finishing

```text
$ wag feature-a --rm
wag: uncommitted changes in:
  ~/projects/feature-a/web
Commit them, or add --force to discard them. Nothing was removed.

$ wag feature-a web --rm
Removed ~/projects/feature-a/web. Branch feature-a in web was kept.
```

wag checks every worktree before removing any of them, so a refusal never leaves a feature half removed.
The branch is always kept, because it may hold commits you have not pushed. Delete it yourself with
`git branch -d feature-a` in the main checkout once it is merged.

## Keeping up with main

All git work after creating the worktrees is your agent's: committing, merging the latest main, resolving conflicts
and pushing. Ask it in the worktree, for example "merge origin/main and resolve the conflicts". wag leaves the
branches alone once the worktrees exist; calling `wag feature-a api` again only prints the path.

### What wag does when it creates a worktree

wag fetches and checks the branch **when it creates a worktree**:

| The feature branch is... | wag does |
|---|---|
| only on origin (a teammate started it) | checks out `origin/<feature>` |
| local and behind origin | fast-forwards it to origin |
| local and ahead of origin | uses it as it is; `git push` sends your commits |
| local and diverged from origin | stops, and changes nothing |
| nowhere yet | creates it from origin's default branch |

It also puts the repo's main checkout back on origin's default branch, which frees the feature's branch when
the main checkout is the thing holding it.

If wag stops because the local branch and origin have **diverged**, the branch has no worktree yet, so reconcile it
with a temporary one (or ask your agent to):

```bash
cd ~/projects/api
git worktree add ../tmp-feature-a feature-a
git -C ../tmp-feature-a pull --no-rebase   # merge origin/feature-a in, resolve any conflicts there
git -C ../tmp-feature-a push
git worktree remove ../tmp-feature-a
wag feature-a api                          # now works
```

## What wag guarantees

- **Nothing is guessed.** wag stops with an error, and changes nothing, when:
  - a repo has no `origin` remote, or `git fetch` fails;
  - a feature name is not a valid branch name (for example `bad name`, `feat//login` or `feat/.login`),
    or a repo name is not a single folder name;
  - the feature's branch is checked out somewhere else (in a main checkout wag could not switch, because it
    has uncommitted changes, or in another worktree);
  - the local branch and `origin/<feature>` have diverged (if the local branch is only behind, it is fast-forwarded);
  - the feature name is the name of a repository folder;
  - the config file has a mistake (the error names the exact key).
- **All or nothing.** When you create several repos, wag checks all of them before touching any.
  If one fails during creation, including one of its create hooks, every worktree and branch made by that call
  is rolled back. A main checkout that was put back on the default branch stays there: nothing is lost by it.
- **New branches start from origin.** A new branch starts from `origin/<feature>` if it exists, otherwise from
  origin's default branch, never from whatever happens to be checked out locally.
- **Local files stay local.** Files copied in by hooks are added to the repo's local exclude list
  (`.git/info/exclude`), so they never show up as changes and are never committed.

```text
$ wag "bad name" api
wag: invalid feature name "bad name". Use letters, digits, dashes and dots; slashes are allowed, spaces are not.
```
