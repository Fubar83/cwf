# Example: tmux with an agent and lazygit

This is one way to use [start profiles](configuration.md#start-profiles): a tmux session per feature, with your
AI agent and lazygit side by side. wag has no tmux code and does not need tmux; this is all config, so change it
freely or use something else entirely.

```text
tmux session "feature-a" (the branch name)
┌─────────────────────────────┬─────────────────────────────┐
│ agent                       │ lazygit                     │
│                             │                             │
│ runs in                     │ runs in                     │
│ ~/projects/feature-a        │ ~/projects/feature-a        │
│                             │                             │
│ 50%                         │ 50%                         │
└─────────────────────────────┴─────────────────────────────┘
```

- The session is named after the branch, which is the feature name.
- Both panes start in the feature folder, so the agent sees every repo of the feature.
- `wag feature-a api web` creates the worktrees, creates the session and attaches to it.
- Running it again, or adding a repo with `wag feature-a docs`, just attaches.
  Inside tmux it switches to the session instead of nesting one.
- The agent gets `WAG_FEATURE`, `WAG_BRANCH` and `WAG_FEATURE_DIR` in its environment.

It needs tmux 3.2 or later, plus your agent and `lazygit` on your PATH. It is written for `sh`, so use it on
Linux, macOS or WSL. Set `agent` to your agent's command, for example `copilot`, `claude`, `codex`, `gemini` or `aider`.

```yaml
start:
  tmux:
    - run: |
        agent="copilot"   # your agent's command, e.g. claude, codex, gemini or aider
        # tmux turns "." and ":" in session names into "_", so do the same to find the session again.
        s=$(printf '%s' "$WAG_BRANCH" | tr '.:' '__')
        if ! tmux has-session -t "=$s" 2>/dev/null; then
          tmux new-session -d -s "$s" -c "$WAG_FEATURE_DIR" \
            -e WAG_FEATURE="$WAG_FEATURE" -e WAG_BRANCH="$WAG_BRANCH" -e WAG_FEATURE_DIR="$WAG_FEATURE_DIR" "$agent"
          tmux split-window -h -l 50% -t "=$s:" -c "$WAG_FEATURE_DIR" lazygit
          tmux select-pane -t "=$s:.0"
        fi
        if [ -n "$TMUX" ]; then tmux switch-client -t "=$s"
        elif [ -t 0 ]; then tmux attach -t "=$s"
        else echo "tmux session $s is ready: tmux attach -t $s" >&2
        fi

autostart: [tmux]
```

This is the `tmux` profile in [examples/config.yaml](../examples/config.yaml).

The feature folder holds the worktrees but is not a git repository itself, so lazygit starts outside a repo
there; use lazygit's recent-repositories list to switch between the feature's worktrees. For a lazygit that is
already open in each repo, use the layout below.

## With one lazygit per repo

```text
tmux session "feature-a" (the branch name)
┌─────────────────────────────┬─────────────────────────────┐
│ agent                       │ lazygit                     │
│                             │ ~/projects/feature-a/       │
│ runs in                     │   api-feature-a             │
│ ~/projects/feature-a,       ├─────────────────────────────┤
│ so it sees every repo       │ lazygit                     │
│ of the feature              │ ~/projects/feature-a/       │
│                             │   web-feature-a             │
└─────────────────────────────┴─────────────────────────────┘
```

- The agent works on all repos from the feature folder, on the left half.
- Each repo gets its own lazygit, already open in its worktree, stacked evenly on the right half.
- `wag feature-a docs` adds the repo and one lazygit pane for it; the panes on the right are re-balanced.
- `wag feature-a web --rm` closes web's lazygit pane, then removes the worktree. It never closes the pane you are
  running wag from.

This is [examples/tmux-lazygit.yaml](../examples/tmux-lazygit.yaml):

```yaml
hooks:
  remove:
    # Close this worktree's lazygit pane. Never closes the pane you are running wag from,
    # and does nothing when tmux is not running.
    - run: |
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
    - run: |
        agent="copilot"   # your agent's command, e.g. claude, codex, gemini or aider
        # tmux turns "." and ":" in session names into "_", so do the same to find the session again.
        s=$(printf '%s' "$WAG_BRANCH" | tr '.:' '__')
        t="=$s:"
        if ! tmux has-session -t "=$s" 2>/dev/null; then
          tmux new-session -d -s "$s" -c "$WAG_FEATURE_DIR" \
            -e WAG_FEATURE="$WAG_FEATURE" -e WAG_BRANCH="$WAG_BRANCH" -e WAG_FEATURE_DIR="$WAG_FEATURE_DIR" "$agent"
        fi
        # One lazygit per worktree, added only for worktrees that do not have one yet.
        have=$(tmux list-panes -t "$t" -F '#{@wag_wt}')
        printf '%s\n' "$WAG_WORKTREES" | while IFS= read -r wt; do
          [ -n "$wt" ] || continue
          printf '%s\n' "$have" | grep -Fqx "$wt" && continue
          pane=$(tmux split-window -t "$t" -c "$wt" -P -F '#{pane_id}' lazygit)
          tmux set-option -p -t "$pane" @wag_wt "$wt"
        done
        # The agent on the left half, the lazygit panes stacked evenly on the right half.
        tmux set-window-option -t "$t" main-pane-width 50%
        tmux select-layout -t "$t" main-vertical
        tmux select-pane -t "$t.0"
        if [ -n "$TMUX" ]; then tmux switch-client -t "=$s"
        elif [ -t 0 ]; then tmux attach -t "=$s"
        else echo "tmux session $s is ready: tmux attach -t $s" >&2
        fi

autostart: [tmux]
```

How it works: each lazygit pane is tagged with its worktree (the tmux pane option `@wag_wt`). That is how a
second call knows which repos already have a pane, and how the remove hook finds the pane to close.
tmux's `main-vertical` layout keeps the first pane, the agent, on the left and stacks the others evenly on the right.

## One repo at a time, with a terminal

```text
tmux session "feature-a" (the branch name)       windows: 0:api*  1:web  2:docs
┌─────────────────────────────┬─────────────────────────────┐
│ agent                       │ lazygit                     │
│                             │ api-feature-a               │
│ runs in                     │                             │
│ ~/projects/feature-a,       │                             │
│ never moves                 ├─────────────────────────────┤
│                             │ terminal  api-feature-a 25% │
└─────────────────────────────┴─────────────────────────────┘
prefix g: the next repo's lazygit and terminal take the right half
```

- The agent stays on the left half and never moves, whichever repo you look at.
- Each repo has its own lazygit and its own terminal, started in its worktree. The right half shows one repo:
  lazygit on top, the terminal in the bottom 25%.
- `prefix g` (`Ctrl-b g`) swaps the next repo's lazygit and terminal into the right half, in repo-name order.
  Their programs keep running; nothing restarts.
- The other repos wait in their own windows, named after them, so the status bar lists every repo. Window 0 is
  named after the repo shown on the right.
- `wag feature-a docs` adds a window for the new repo. `wag feature-a web --rm` closes web's panes; if web was on
  the right, the next repo is shown there first. It never closes the pane you are running wag from.

The key needs a small script, because a tmux key binding runs a command. Copy
[examples/tmux-next-repo.sh](../examples/tmux-next-repo.sh) to `~/.config/wag/tmux-next-repo.sh`.
The profile binds `prefix g` to it each time it runs. This is [examples/tmux-switch.yaml](../examples/tmux-switch.yaml):

```yaml
hooks:
  remove:
    # Close this repo's lazygit and terminal. If they are on the right of the main window, show the next repo
    # there first. Never closes the pane you are running wag from, and does nothing when tmux is not running.
    - run: |
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
    - run: |
        agent="copilot"   # your agent's command, e.g. claude, codex, gemini or aider
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
        # A lazygit and a terminal per repo, added only for repos that do not have them yet.
        have=$(tmux list-panes -s -t "=$s" -F '#{@wag_wt}')
        printf '%s\n' "$WAG_WORKTREES" | while IFS= read -r wt; do
          [ -n "$wt" ] || continue
          printf '%s\n' "$have" | grep -Fqx "$wt" && continue
          b=$(basename "$wt"); repo=${b%-"$WAG_BRANCH"}
          if tmux list-panes -t "$main" -F '#{@wag_role}' | grep -qx git; then
            git=$(tmux new-window -d -t "=$s:" -n "$repo" -c "$wt" -P -F '#{pane_id}' lazygit)
          else
            git=$(tmux split-window -d -h -l 50% -t "$main" -c "$wt" -P -F '#{pane_id}' lazygit)
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

How it works: every lazygit and terminal pane is tagged with its repo and worktree, and the session remembers its
main window. The script finds the repo shown on the right, picks the next one, and swaps both of its panes in with
`tmux swap-pane`, which moves panes without restarting what runs in them. `prefix g` is bound for the whole tmux
server, but the script does nothing in sessions wag did not create.

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
| `o` or arrow keys | Move between the two panes. |
| `s` | Pick a session, to jump between features. |
| `d` | Detach. `wag feature-a api` or `tmux attach -t feature-a` brings you back. |

wag never closes the session by itself: you might be running wag from inside it, and closing it would stop wag
halfway. Close it with `tmux kill-session -t feature-a` when you are done.

## Changing it

- **Another agent.** Set `agent`, for example `agent="claude"`. Arguments work too: `agent="aider --model sonnet"`.
- **Other split.** Change `-l 50%`, for example to `-l 40%` for a narrower lazygit.
- **Other programs.** Replace `lazygit` with any command, such as `gitui`, `nvim` or a shell.
- **Only sometimes.** Remove `autostart: [tmux]` and open tmux with `wag feature-a api +tmux` when you want it.

## How the examples are tested

All three profiles were run with tmux 3.4 in WSL, using stand-ins for the agent and lazygit.

- **Two panes:** one session named after the branch, two panes of equal width with the agent on the left, both in
  the feature folder; a second call adds nothing; a branch name with a dot finds its session again.
- **One lazygit per repo:** the agent on the left half in the feature folder, each lazygit on the right half in its
  own worktree; a second call adds nothing; a new repo adds exactly one lazygit; removing a repo closes only its
  pane and never the pane you are in; the remove hook exits cleanly without a session and also works for a branch
  name with a dot.
- **One repo at a time:** the agent on the left half never moves; the right half shows one repo's lazygit with its
  terminal in the bottom 25%, both in its worktree; `prefix g` is bound, and running it swaps the next repo in and
  renames the windows; repeated presses cycle through all repos; a new repo gets its own window; removing the shown
  repo shows the next one and closes its panes; the pane you are in is never closed; a branch with a dot works.
