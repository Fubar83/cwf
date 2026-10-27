# Using wag

wag gives each feature its own folder, with one git worktree per repo you work on, all on a branch with
the feature's name. Your main checkouts stay on main and up to date, so you can work on several features side by side.

## The layout

```text
~/projects/
├── api/                          main checkout of api, kept on main and up to date
├── web/                          main checkout of web
└── feature-a/                    the feature folder
    ├── api-feature-a/            worktree of api, branch feature-a, tracking origin/feature-a
    └── web-feature-a/            worktree of web, branch feature-a, tracking origin/feature-a
```

- **Main checkouts** are the normal clones, directly under `projects` (or wherever a repo's `path` says).
  wag keeps them on origin's default branch and up to date, see [main checkouts](#main-checkouts).
- **The feature folder** is `projects/<feature>`. It only holds worktrees.
- **Each worktree** is `projects/<feature>/<repo>-<feature>`, made with `git worktree`. Nothing is copied:
  git shares the repository between the main checkout and its worktrees.
- **The branch** is `<feature>` in every repo, and it tracks `origin/<feature>`. A plain `git push`
  from a worktree creates or updates the same-named branch on origin.

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
| `wag <feature> [<repo>...] --merge` | Merges origin's default branch into the worktrees. Run it again after resolving conflicts to finish. |
| `wag <feature> [<repo>...] --merge --abort` | Backs out the merges in progress. |
| `wag --help` | Shows usage and which config file is used. |

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
create hooks for api-feature-a:
  copied .env
  run: git log --oneline -1
093cdd3 Initial commit
Created api-feature-a on branch feature-a, tracking origin/feature-a.
create hooks for web-feature-a:
  skip copy: ~/projects/web/.env does not exist (optional)
Created web-feature-a on branch feature-a, tracking origin/feature-a.
~/projects/feature-a

$ wag
feature-a
  api                  ~/projects/feature-a/api-feature-a
  web                  ~/projects/feature-a/web-feature-a

$ wag feature-a api
~/projects/feature-a/api-feature-a
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
  ~/projects/feature-a/web-feature-a
Commit them, or add --force to discard them. Nothing was removed.

$ wag feature-a web --rm
Removed ~/projects/feature-a/web-feature-a. Branch feature-a in web was kept.
```

wag checks every worktree before removing any of them, so a refusal never leaves a feature half removed.
The branch is always kept, because it may hold commits you have not pushed. Delete it yourself with
`git branch -d feature-a` in the main checkout once it is merged.

## Keeping up with main, and resolving conflicts

### Bringing in the latest main

`wag feature-a --merge` merges origin's default branch, such as `origin/main`, into every worktree of the feature
(or only the repos you name: `wag feature-a api --merge`):

1. It fetches every repo and checks them all first. If any repo has uncommitted changes, it stops before merging
   anything, so a feature is never half merged because of a forgotten file.
2. It merges each repo that is behind, and says which ones are already up to date.
3. A repo with conflicts is left mid-merge, with the conflicted files listed. The other repos are still merged.

This is real output, for a feature where `api` has a conflict and `web` merges cleanly:

```text
$ wag feature-a --merge
api: conflicts in 1 file(s), in ~/projects/feature-a/api-feature-a:
    Program.cs
web: merged origin/main

Resolve the conflicts (or ask your agent to), git add the files, then run: wag feature-a --merge
To undo the merges instead: wag feature-a --merge --abort
```

### Resolving conflicts

Resolve the listed files in the worktree, or ask your AI agent to, and `git add` them. Then run the same command
again; it finishes every merge whose conflicts are resolved, and lists what is still left:

```text
$ wag feature-a --merge
api: merge finished
web: already up to date with origin/main
```

- `wag feature-a --merge --abort` backs out every merge in progress instead, and leaves the branches as they were.
- The exit code is `1` while conflicts are left, and `0` when everything is merged.
- wag merges, and never rebases or force-pushes, so commits that are already on origin are never rewritten.
  After merging, a plain `git push` from the worktree publishes the merge.
- In a [git pane](tmux.md#the-git-pane), conflicted files show as `UU`, and a hint appears when origin's default
  branch has commits you have not merged yet. With [delta](tmux.md#reading-diffs-delta) and
  `conflictStyle = zdiff3`, `git diff` shows conflicts clearly.

### A teammate's commits on the same branch

When someone else pushes to `origin/feature-a`, take their commits in the worktree with plain git:

```bash
cd "$(wag feature-a api)"
git pull --no-rebase
```

### What wag does when it creates a worktree

wag fetches and checks the branch **when it creates a worktree**:

| The feature branch is... | wag does |
|---|---|
| only on origin (a teammate started it) | checks out `origin/<feature>` |
| local and behind origin | fast-forwards it to origin |
| local and ahead of origin | uses it as it is; `git push` sends your commits |
| local and diverged from origin | stops, and changes nothing |
| nowhere yet | creates it from origin's default branch |

If wag stops because the local branch and origin have **diverged**, the branch has no worktree yet, so reconcile it
with a temporary one:

```bash
cd ~/projects/api
git worktree add ../tmp-feature-a feature-a
git -C ../tmp-feature-a pull --no-rebase   # merge origin/feature-a in, resolve any conflicts there
git -C ../tmp-feature-a push
git worktree remove ../tmp-feature-a
wag feature-a api                          # now works
```

## Main checkouts

The main checkouts in your projects folder, such as `~/projects/api`, stay on origin's default branch and up to
date, so they are always a current copy of main to read, run or compare with. wag updates them whenever it
fetches: when it creates worktrees, and when you run `wag feature-a --merge`. Only safe moves are made:

| The main checkout is... | wag does |
|---|---|
| on main, clean, behind origin | fast-forwards it to `origin/main` |
| on another branch, clean | switches it back to main, then fast-forwards it |
| changed: uncommitted changes or new files | leaves it as it is, and says so if it is behind |
| on main with local commits that are not on origin | leaves it as it is, and says so |

wag never commits, resets, rebases or discards anything in a main checkout, and a problem there never stops the
feature work. Do your own work in feature worktrees, and the main checkouts take care of themselves.

```text
$ wag feature-a api web
...
api: main checkout updated to origin/main
web: main checkout switched from experiment to main
```

## What wag guarantees

- **Nothing is guessed.** wag stops with an error, and changes nothing, when:
  - a repo has no `origin` remote, or `git fetch` fails;
  - a feature or repo name is not a valid branch name (for example `bad name`), or contains a slash;
  - the feature's branch is checked out somewhere else, such as in the main checkout;
  - the local branch and `origin/<feature>` have diverged (if the local branch is only behind, it is fast-forwarded);
  - the feature name is the name of a repository folder;
  - the config file has a mistake (the error names the exact key).
- **All or nothing.** When you create several repos, wag checks all of them before touching any.
  If one fails during creation, including one of its create hooks, every worktree and branch made by that call
  is rolled back.
- **New branches start from origin.** A new branch starts from `origin/<feature>` if it exists, otherwise from
  origin's default branch, never from whatever happens to be checked out locally.
- **Local files stay local.** Files copied in by hooks are added to the repo's local exclude list
  (`.git/info/exclude`), so they never show up as changes and are never committed.

```text
$ wag "bad name" api
wag: invalid feature name "bad name". Use letters, digits, dashes and dots, no spaces or slashes.
```
