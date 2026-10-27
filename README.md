# wag

**W**orktrees, **A**gents, **G**it. Feature worktrees across repos. One feature gets one folder, with a git worktree per repo,
all on a branch with the feature's name. Hooks bring in your local files, and start profiles
open your tools, for example a tmux session with Copilot and lazygit.

```text
~/projects/
├── repo1/                        main checkout
├── repo2/                        main checkout
└── feature-a/
    ├── repo1-feature-a/          worktree on branch feature-a
    └── repo2-feature-a/          worktree on branch feature-a
```

## Install

```bash
git clone https://github.com/Fubar83/wag.git
cd wag
pnpm run global
mkdir -p ~/.config/wag && cp examples/config.yaml ~/.config/wag/config.yaml   # then edit it
```

If pnpm's global bin folder is not on your PATH yet, run `pnpm setup` once and open a new terminal.
Requires Node 22+ and git.

## Use

```bash
wag feature-a repo1 repo2    # create the worktrees (if missing), run autostart, print the feature folder
wag feature-a repo1          # one repo: prints its worktree, so cd "$(wag feature-a repo1)" works
wag feature-a repo3 +tmux    # add a repo, run the "tmux" start profile instead of autostart
wag feature-a repo1 --no-start
wag                          # all features
wag feature-a                # the worktrees of feature-a
wag feature-a --rm           # remove all of feature-a's worktrees (branches are kept)
wag feature-a repo2 --rm     # remove one; --force discards uncommitted changes and ignores failing hooks
```

wag never changes your shell's directory. Only the path goes to stdout; everything else goes to stderr.

## What it guarantees

- **Same branch name everywhere.** Every repo in a feature gets the branch `<feature>`, tracking `origin/<feature>`.
  A plain `git push` from a worktree updates the same-named branch on origin. An existing `origin/<feature>` is picked up.
- **Nothing is guessed.** wag stops with an error, and changes nothing, when origin is missing or cannot be fetched,
  a name is invalid, the branch is checked out elsewhere, the local branch has diverged from origin, or the config is wrong.
- **All or nothing.** Creating several repos checks all of them first. If one fails, including one of its create hooks,
  every worktree and branch made by that call is rolled back. Removing checks every worktree for uncommitted changes,
  and runs every remove hook, before removing anything.
- **Local files stay local.** Files copied in by hooks are added to the repo's local exclude list, so they are never committed.

## Config

Everything lives in your home folder: `~/.config/wag/config.yaml` (or `$XDG_CONFIG_HOME/wag/config.yaml`,
or the file in `$WAG_CONFIG`). Nothing is needed in the repos. `wag --help` shows which file is used.
See [examples/config.yaml](examples/config.yaml) for a complete, commented example.

```yaml
projects: ~/projects

hooks:                      # every repo
  create:
    - copy: .env            # relative: from the repo's main checkout
      optional: true
repos:
  repo1:
    create:
      - copy: ~/secrets/repo1/appsettings.Local.json
        to: src/Api/appsettings.Local.json
      - run: npm ci
    remove:
      - run: docker compose down

start:                      # pick with +name
  tmux:
    - run: …                # see examples/config.yaml
autostart: [tmux]           # runs when no +name is given
```

- **create** hooks run after a worktree is made, **remove** hooks before it is removed. Global steps run first,
  then the repo's own. `run` steps get `WAG_FEATURE`, `WAG_REPO`, `WAG_WORKTREE` and `WAG_MAIN`.
- **Start profiles** run once per call for the whole feature, in the printed path. They get `WAG_FEATURE`,
  `WAG_FEATURE_DIR`, and newline-separated `WAG_REPOS` and `WAG_WORKTREES`. A failing start profile
  is reported but never removes anything.
- `run` uses your system shell: `sh` on Linux and macOS, `cmd.exe` on Windows.

### The tmux profile

The example's `tmux` profile opens one session per feature:

- **Copilot on the left half**, started in the feature folder, so one Copilot works on all the repos at once.
- **One lazygit per repo** stacked on the right half (lazygit works on one repo at a time).
- Running wag again attaches to the session; adding a repo later adds only its lazygit pane.

It needs tmux 3.2 or later, so Linux, macOS or WSL. Zoom a pane with tmux's `prefix z`.

## Copilot

Copilot's own settings stay in its home folder, `~/.copilot/`. wag does not write Copilot files into repos.

- **Hooks:** the Copilot CLI loads personal hooks from `~/.copilot/hooks/*.json`
  ([hooks reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference)).
  There is no command-line flag to add hooks when starting it.
- **Per-feature behaviour:** the tmux profile starts Copilot with `WAG_FEATURE` and `WAG_FEATURE_DIR` in its
  environment, so a hook in `~/.copilot/hooks/` can read them and act per feature.

## Development

```bash
pnpm install
pnpm test
```

The tests run wag against real local git repos with bare origins. No network needed.
