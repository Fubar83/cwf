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

Both profiles were run with tmux 3.4 in WSL, using stand-ins for the agent and lazygit.

- **Two panes:** one session named after the branch, two panes of equal width with the agent on the left, both in
  the feature folder; a second call adds nothing; a branch name with a dot finds its session again.
- **One lazygit per repo:** the agent on the left half in the feature folder, each lazygit on the right half in its
  own worktree; a second call adds nothing; a new repo adds exactly one lazygit; removing a repo closes only its
  pane and never the pane you are in; the remove hook exits cleanly without a session and also works for a branch
  name with a dot.
