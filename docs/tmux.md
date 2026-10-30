# Examples: tmux with your agent and a git pane

These are ways to use [start profiles](configuration.md#start-profiles): a tmux session per feature, named after
the branch, with your AI agent working on the feature and a git pane that shows what it is doing. wag has no tmux
code and does not need tmux; this is all config, so change it freely or use something else entirely.

| | Two panes | One git pane per repo | One repo at a time |
|---|---|---|---|
| Agent | Left half, feature folder | Left half, feature folder | Left half, feature folder, never moves |
| Git pane | One, for every repo | One per repo, stacked | One repo's, swapped with `prefix g` |
| Terminal | – | – | Below the git pane, 25% |
| File | [config.yaml](../examples/config.yaml) | [tmux-per-repo.yaml](../examples/tmux-per-repo.yaml) | [tmux-switch.yaml](../examples/tmux-switch.yaml) |

All three need tmux 3.2 or later and your agent on your PATH, and are written for `sh`, so use them on Linux,
macOS or WSL. Set `agent` in the profile to your agent's command (`copilot`, `claude`, `codex`, `gemini`, `aider`, …).

To install one, copy it to `~/.config/wag/config.yaml`, and copy [git-view.sh](../examples/git-view.sh) (and, for
the third layout, [tmux-next-repo.sh](../examples/tmux-next-repo.sh)) to `~/.config/wag/`.

## The git pane

When your agent makes the changes and the commits, the git pane only needs to show what is going on. By default it
runs [examples/git-view.sh](../examples/git-view.sh), a live, read-only view. In a feature folder it shows every
repo of the feature; in a worktree it shows that repo. This is its real output for a feature with two repos:

```text
git view · green staged · red not staged · ?? new · 14:03:12
api
## feature-a...origin/feature-a [ahead 1]
A  CsvExportTests.cs
 M Program.cs
?? notes.md
   staged: 1 file changed, 1 insertion(+)
   not staged: 1 file changed, 2 insertions(+), 1 deletion(-)
   origin/main has 1 commit(s) to merge (as of the last fetch)
5809750 (HEAD -> feature-a) Use semicolons as separator
c6cd5cb (origin/feature-a) Add CSV export endpoint
cfe1e65 (main) Initial commit

web
## feature-a (not pushed yet)
A  DownloadButton.tsx
   staged: 1 file changed, 1 insertion(+)
d2cf2cd (HEAD -> feature-a, origin/main, origin/HEAD, main) Initial commit
```

For each repo:

- **Branch line:** the branch and how it relates to origin: `...origin/feature-a` with `[ahead 1]` means one
  commit is not pushed yet, `(not pushed yet)` means the branch is not on origin at all.
- **Files:** the first column is staged (green in the pane), the second is not staged (red); `A` added,
  `M` modified, `D` deleted, `??` a new file git does not track yet.
- **Line counts** for staged and not-staged changes.
- **Merge hint:** when origin's default branch has commits the feature does not have yet; ask your agent to merge
  them (see [usage](usage.md#keeping-up-with-main)).
- **Latest commits:** 8 for one repo, 3 per repo in a feature folder. Change it with a number after the folder:
  `sh ~/.config/wag/git-view.sh . 5`.

It is live without being jumpy: it checks every 2 seconds and redraws only when something changed, in place,
without clearing the screen; long lines are cut off instead of wrapped, and the view is cut to the pane's height, so
nothing scrolls. It also never takes git's index lock, so it cannot make your agent's `git add` or `git commit` fail
while it watches. The header shows when it last changed.

### Reading diffs: delta

The git view shows what changed, not how. For full diffs, use `git show`, `git diff` or `git log -p` in a terminal,
for example the terminal pane of the third layout. [delta](https://github.com/dandavison/delta) makes them easy to
read, with syntax highlighting and line numbers. Install it, then add this to `~/.gitconfig`:

```ini
[core]
    pager = delta
[interactive]
    diffFilter = delta --color-only
[delta]
    navigate = true      # n and N jump between files
    line-numbers = true
[merge]
    conflictStyle = zdiff3
```

### Another git tool

Set `git_ui` in the profile to use something else in the git pane:

- `git_ui="lazygit"`: stage, commit and browse interactively. lazygit needs to start in a repo, so use it with the
  second or third layout, where each git pane runs in a worktree.
- `git_ui="tig"`: browse commits and their diffs; `tig status` for the files.

## Two panes

```text
tmux session "feature-a" (the branch name)
┌─────────────────────────────┬─────────────────────────────┐
│ agent                       │ git view                    │
│                             │ every repo of the feature   │
│ runs in                     │                             │
│ ~/projects/feature-a,       │ runs in                     │
│ sees every repo             │ ~/projects/feature-a        │
│ 50%                         │ 50%                         │
└─────────────────────────────┴─────────────────────────────┘
```

- `wag feature-a api web` creates the worktrees, creates the session and attaches to it.
- Running it again just attaches. Adding a repo with `wag feature-a docs` attaches too, and the new repo shows up
  in the git pane by itself, because the git pane watches the whole feature folder.
- Inside tmux it switches to the session instead of nesting one.
- The agent gets `WAG_FEATURE`, `WAG_BRANCH` and `WAG_FEATURE_DIR` in its environment.

This is the `tmux` profile in [examples/config.yaml](../examples/config.yaml):

```yaml
start:
  # A tmux session named after the branch, with two panes side by side, both in the feature folder (needs tmux 3.2+):
  #
  #   left half:  your AI agent ("agent"), working on every repo of the feature
  #   right half: the git pane ("git_ui"), a live, read-only view of every repo of the feature:
  #               for each worktree its branch and whether it is pushed, staged (green) and not-staged (red) files
  #               with line counts, new files (??), commits on origin's default branch not merged yet, and the
  #               latest commits. It redraws in place only when something changes, so it stays still while the
  #               agent works, and it never takes git's index lock, so it cannot get in the agent's way.
  #               Set git_ui to lazygit or tig for an interactive tool instead.
  #
  # Calling wag again, or adding a repo, attaches to the session; a new repo shows up in the git pane by itself.
  tmux:
    - |
      agent="copilot"                              # your agent: copilot, claude, codex, gemini, aider, ...
      git_ui="sh $HOME/.config/wag/git-view.sh"   # the git pane: this live view, or lazygit, or tig
      # tmux turns "." and ":" in session names into "_", so do the same to find the session again.
      s=$(printf '%s' "$WAG_BRANCH" | tr '.:' '__')
      if ! tmux has-session -t "=$s" 2>/dev/null; then
        tmux new-session -d -s "$s" -c "$WAG_FEATURE_DIR" \
          -e WAG_FEATURE="$WAG_FEATURE" -e WAG_BRANCH="$WAG_BRANCH" -e WAG_FEATURE_DIR="$WAG_FEATURE_DIR" "$agent"
        tmux split-window -h -l 50% -t "=$s:" -c "$WAG_FEATURE_DIR" "$git_ui"
        tmux select-pane -t "=$s:.0"
      fi
      if [ -n "$TMUX" ]; then tmux switch-client -t "=$s"
      elif [ -t 0 ]; then tmux attach -t "=$s"
      else echo "tmux session $s is ready: tmux attach -t $s" >&2
      fi

# Start profiles to run when no +name is given. `--no-start` skips them for one call.
autostart: [tmux]
```

## One git pane per repo

```text
tmux session "feature-a"
┌─────────────────────────────┬─────────────────────────────┐
│ agent                       │ git view  api               │
│                             │                             │
│ runs in                     ├─────────────────────────────┤
│ ~/projects/feature-a,       │ git view  web               │
│ sees every repo             │                             │
└─────────────────────────────┴─────────────────────────────┘
```

- Each repo gets its own git pane, in its worktree, stacked evenly on the right half.
- `wag feature-a docs` adds one git pane for the new repo; the panes on the right are re-balanced.
- `wag feature-a web --rm` closes web's git pane, then removes the worktree. It never closes the pane you are
  running wag from.
- Each git pane is tagged with its worktree (the tmux pane option `@wag_wt`), so a second call knows which repos
  already have one, and the remove hook knows which pane to close.

This is [examples/tmux-per-repo.yaml](../examples/tmux-per-repo.yaml):

```yaml
hooks:
  repo:
    remove:
      # Close this worktree's git pane. Never closes the pane you are running wag from,
      # and does nothing when tmux is not running.
      - |
        command -v tmux >/dev/null 2>&1 || exit 0
        s=$(printf '%s' "$WAG_BRANCH" | tr '.:' '__')
        tmux has-session -t "=$s" 2>/dev/null || exit 0
        tmux list-panes -s -t "=$s" -F '#{pane_id} #{@wag_wt}' | while read -r id wt; do
          [ "$wt" = "$WAG_WORKTREE" ] && [ "$id" != "$TMUX_PANE" ] && tmux kill-pane -t "$id"
        done
        tmux select-layout -t "=$s:" main-vertical 2>/dev/null
        exit 0

start:
  tmux:
    - |
      agent="copilot"                              # your agent: copilot, claude, codex, gemini, aider, ...
      git_ui="sh $HOME/.config/wag/git-view.sh"   # the git pane: this live view, or lazygit, or tig
      # tmux turns "." and ":" in session names into "_", so do the same to find the session again.
      s=$(printf '%s' "$WAG_BRANCH" | tr '.:' '__')
      t="=$s:"
      if ! tmux has-session -t "=$s" 2>/dev/null; then
        tmux new-session -d -s "$s" -c "$WAG_FEATURE_DIR" \
          -e WAG_FEATURE="$WAG_FEATURE" -e WAG_BRANCH="$WAG_BRANCH" -e WAG_FEATURE_DIR="$WAG_FEATURE_DIR" "$agent"
      fi
      # One git pane per worktree, added only for worktrees that do not have one yet.
      have=$(tmux list-panes -t "$t" -F '#{@wag_wt}')
      printf '%s\n' "$WAG_WORKTREES" | while IFS= read -r wt; do
        [ -n "$wt" ] || continue
        printf '%s\n' "$have" | grep -Fqx "$wt" && continue
        pane=$(tmux split-window -t "$t" -c "$wt" -P -F '#{pane_id}' "$git_ui")
        tmux set-option -p -t "$pane" @wag_wt "$wt"
      done
      # The agent on the left half, the git panes stacked evenly on the right half.
      tmux set-window-option -t "$t" main-pane-width 50%
      tmux select-layout -t "$t" main-vertical
      tmux select-pane -t "$t.0"
      if [ -n "$TMUX" ]; then tmux switch-client -t "=$s"
      elif [ -t 0 ]; then tmux attach -t "=$s"
      else echo "tmux session $s is ready: tmux attach -t $s" >&2
      fi

autostart: [tmux]
```

## One repo at a time, with a terminal

```text
tmux session "feature-a"                       windows: 0:api*  1:web  2:docs
┌─────────────────────────────┬─────────────────────────────┐
│ agent                       │ git view  api               │
│                             │                             │
│ runs in                     │                             │
│ ~/projects/feature-a,       ├─────────────────────────────┤
│ never moves                 │ terminal  api          25%  │
└─────────────────────────────┴─────────────────────────────┘
prefix g: the next repo's git pane and terminal take the right half
```

- The agent stays on the left half and never moves, whichever repo you look at.
- Each repo has its own git pane and its own terminal, started in its worktree. The right half shows one repo: the
  git pane on top, the terminal in the bottom 25%, for `git show`, `git diff` or anything else.
- `prefix g` (`Ctrl-b g`) swaps the next repo's git pane and terminal into the right half, in repo-name order.
  Their programs keep running; nothing restarts.
- The other repos wait in their own windows, named after them, so the status bar lists every repo. Window 0 is
  named after the repo shown on the right.
- `wag feature-a docs` adds a window for the new repo. `wag feature-a web --rm` closes web's panes; if web was on
  the right, the next repo is shown there first. It never closes the pane you are running wag from.

The key runs [examples/tmux-next-repo.sh](../examples/tmux-next-repo.sh), which you copy to
`~/.config/wag/tmux-next-repo.sh`; the profile binds `prefix g` to it each time it runs. It finds the repo shown on
the right, picks the next one, and swaps both of its panes in with `tmux swap-pane`, which moves panes without
restarting what runs in them. The binding is for the whole tmux server, but the script does nothing in sessions wag
did not create. This is [examples/tmux-switch.yaml](../examples/tmux-switch.yaml):

```yaml
hooks:
  repo:
    remove:
      # Close this repo's git pane and terminal. If they are on the right of the main window, show the next repo
      # there first. Never closes the pane you are running wag from, and does nothing when tmux is not running.
      - |
        command -v tmux >/dev/null 2>&1 || exit 0
        s=$(printf '%s' "$WAG_BRANCH" | tr '.:' '__')
        tmux has-session -t "=$s" 2>/dev/null || exit 0
        main=$(tmux show-options -t "=$s:" -v @wag_main 2>/dev/null)
        panes=$(tmux list-panes -s -t "=$s" -F '#{window_id} #{pane_id} #{@wag_role} #{@wag_wt}')
        shown=no; mine=no
        while read -r win id role wt; do
          [ "$wt" = "$WAG_WORKTREE" ] || continue
          [ "$win" = "$main" ] && shown=yes
          [ "$id" = "$TMUX_PANE" ] && mine=yes
        done <<EOF
        $panes
        EOF
        if [ "$shown" = yes ] && [ "$mine" = no ]; then
          sh "$HOME/.config/wag/tmux-next-repo.sh" "$s"
        fi
        while read -r win id role wt; do
          [ "$wt" = "$WAG_WORKTREE" ] && [ "$id" != "$TMUX_PANE" ] && tmux kill-pane -t "$id"
        done <<EOF
        $panes
        EOF
        exit 0

start:
  tmux:
    - |
      agent="copilot"                              # your agent: copilot, claude, codex, gemini, aider, ...
      git_ui="sh $HOME/.config/wag/git-view.sh"   # the git pane: this live view, or lazygit, or tig
      next="$HOME/.config/wag/tmux-next-repo.sh"
      # tmux turns "." and ":" in session names into "_", so do the same to find the session again.
      s=$(printf '%s' "$WAG_BRANCH" | tr '.:' '__')
      if ! tmux has-session -t "=$s" 2>/dev/null; then
        tmux new-session -d -s "$s" -c "$WAG_FEATURE_DIR" \
          -e WAG_FEATURE="$WAG_FEATURE" -e WAG_BRANCH="$WAG_BRANCH" -e WAG_FEATURE_DIR="$WAG_FEATURE_DIR" "$agent"
        tmux set-option -t "=$s:" @wag_main "$(tmux display -p -t "=$s:" '#{window_id}')"
      fi
      main=$(tmux show-options -t "=$s:" -v @wag_main)
      tmux bind-key g run-shell "sh '$next' '#{session_name}'"
      # A git pane and a terminal per repo, added only for repos that do not have them yet.
      have=$(tmux list-panes -s -t "=$s" -F '#{@wag_wt}')
      printf '%s\n' "$WAG_WORKTREES" | while IFS= read -r wt; do
        [ -n "$wt" ] || continue
        printf '%s\n' "$have" | grep -Fqx "$wt" && continue
        b=$(basename "$wt"); repo=${b%-"$WAG_BRANCH"}
        if tmux list-panes -t "$main" -F '#{@wag_role}' | grep -qx git; then
          git=$(tmux new-window -d -t "=$s:" -n "$repo" -c "$wt" -P -F '#{pane_id}' "$git_ui")
        else
          git=$(tmux split-window -d -h -l 50% -t "$main" -c "$wt" -P -F '#{pane_id}' "$git_ui")
          tmux rename-window -t "$main" "$repo"
        fi
        term=$(tmux split-window -d -v -l 25% -t "$git" -c "$wt" -P -F '#{pane_id}')
        for p in "$git" "$term"; do
          tmux set-option -p -t "$p" @wag_wt "$wt"
          tmux set-option -p -t "$p" @wag_repo "$repo"
        done
        tmux set-option -p -t "$git" @wag_role git
        tmux set-option -p -t "$term" @wag_role term
      done
      tmux select-window -t "$main"
      if [ -n "$TMUX" ]; then tmux switch-client -t "=$s"
      elif [ -t 0 ]; then tmux attach -t "=$s"
      else echo "tmux session $s is ready: tmux attach -t $s" >&2
      fi

autostart: [tmux]
```

## Day to day

```bash
wag feature-a api web              # create (if needed) and open the session
wag feature-a api web --no-start   # create without opening tmux
tmux kill-session -t feature-a     # close the session when you are done
```

Useful tmux keys, after your prefix (`Ctrl-b` by default):

| Keys | Does |
|---|---|
| `z` | Zoom the current pane to full size, and back. |
| `o` or arrow keys | Move between panes. |
| `g` | Show the next repo (third layout). |
| `s` | Pick a session, to jump between features. |
| `d` | Detach. `wag feature-a api` or `tmux attach -t feature-a` brings you back. |

wag never closes the whole session by itself: you might be running wag from inside it, and closing it would stop
wag halfway. Close it with `tmux kill-session -t feature-a` when you are done.

## Changing them

- **Another agent.** Set `agent`, for example `agent="claude"`. Arguments work too: `agent="aider --model sonnet"`.
- **Another git tool.** Set `git_ui`, see [above](#another-git-tool).
- **Other split.** Change `-l 50%` or `main-pane-width 50%`, or `-l 25%` for the terminal.
- **Only sometimes.** Remove `autostart: [tmux]` and open tmux with `wag feature-a api +tmux` when you want it.

## How the examples are tested

The profiles and scripts were run with tmux 3.4 in WSL, using a stand-in for the agent and the real git view.

- **The git view** against real repos in a tmux pane: new files, staged changes and new commits show up by themselves;
  commits on main that are not merged yet are pointed out; a feature folder shows every worktree with 3 commits
  each; it never clears the screen when redrawing; and a small pane does not scroll.
- **Two panes:** one session named after the branch, two panes of equal width with the agent on the left, both in
  the feature folder; a second call adds nothing; a branch name with a dot finds its session again.
- **One git pane per repo:** the agent on the left half in the feature folder, each git pane on the right half in
  its own worktree; a second call adds nothing; a new repo adds exactly one pane; removing a repo closes only its
  pane and never the pane you are in; the remove hook exits cleanly without a session and works for a branch with a dot.
- **One repo at a time:** the agent on the left half never moves; the right half shows one repo's git pane with its
  terminal in the bottom 25%, both in its worktree; the bound `prefix g` command swaps the next repo in and renames
  the windows; repeated presses cycle through all repos; a new repo gets its own window; removing the shown repo
  shows the next one and closes its panes; the pane you are in is never closed; a branch with a dot works.
