# Using wag

wag gives each feature its own folder, with one git worktree per repo you work on, all on a branch with
the feature's name. Your main checkouts stay untouched, so you can work on several features side by side.

## The layout

```text
~/projects/
├── api/                          main checkout of api (stays on its own branch)
├── web/                          main checkout of web
└── feature-a/                    the feature folder
    ├── api-feature-a/            worktree of api, branch feature-a, tracking origin/feature-a
    └── web-feature-a/            worktree of web, branch feature-a, tracking origin/feature-a
```

- **Main checkouts** are the normal clones, directly under `projects` (or wherever a repo's `path` says).
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
copilot                        # or your editor, or a start profile that opens everything (see tmux.md)
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

## When origin moves on, and merge conflicts

wag fetches and checks the branch **when it creates a worktree**:

| The feature branch is... | wag does |
|---|---|
| only on origin (a teammate started it) | checks out `origin/<feature>` |
| local and behind origin | fast-forwards it to origin |
| local and ahead of origin | uses it as it is; `git push` sends your commits |
| local and diverged from origin | stops, and changes nothing |
| nowhere yet | creates it from origin's default branch |

Once the worktree exists, wag leaves the branch alone: calling `wag feature-a api` again only prints the path.
Keeping it up to date is plain git, in the worktree:

```bash
cd "$(wag feature-a api)"
git pull --ff-only             # take a teammate's new commits on origin/feature-a
git fetch && git merge origin/main   # bring in the latest main (use your default branch's name)
```

If a merge or pull stops with conflicts, resolve them in the worktree like in any checkout: fix the files,
`git add` them and `git commit` (or `git merge --abort` to back out). lazygit shows conflicted files and lets you
pick sides, and Copilot can help with the edits. wag never rebases or force-pushes, so it never rewrites
commits that are already on origin.

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

## What wag guarantees

- **Nothing is guessed.** wag stops with an error, and changes nothing, when:
  - a repo has no `origin` remote, or `git fetch` fails;
  - a feature or repo name is not a valid branch name (for example `bad name`);
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
wag: invalid feature name "bad name". Use letters, digits, dashes and dots, no spaces.
```
