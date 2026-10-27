# tmux with Copilot and lazygit

wag can open a tmux session for each feature, with Copilot and lazygit already running. This is done with a
[start profile](configuration.md#start-profiles) and a remove hook in your config. wag itself has no tmux code,
so you can change the layout freely.

There are two ready-made layouts. Pick one.

| | Layout A: one Copilot for all repos | Layout B: one window per repo |
|---|---|---|
| Copilot | One, in the feature folder, sees every repo | One per repo, in that repo's worktree |
| lazygit | One per repo, stacked on the right | One per repo, next to its Copilot |
| Good for | Changes that span repos | Repos you work on separately |
| File | [examples/config.yaml](../examples/config.yaml) | [examples/tmux-windows.yaml](../examples/tmux-windows.yaml) |

Both need tmux 3.2 or later, and `copilot` and `lazygit` on your PATH. They are written for `sh`, so use them on
Linux, macOS or WSL.

## Layout A: one Copilot for all repos

```text
tmux session "feature-a"
┌─────────────────────────────┬─────────────────────────────┐
│ copilot                     │ lazygit                     │
│                             │ ~/projects/feature-a/       │
│ runs in                     │   api-feature-a             │
│ ~/projects/feature-a,       ├─────────────────────────────┤
│ so it sees every repo       │ lazygit                     │
│ of the feature              │ ~/projects/feature-a/       │
│                             │   web-feature-a             │
└─────────────────────────────┴─────────────────────────────┘
```

- `wag feature-a api web` creates the worktrees, creates the session and attaches to it.
- Running it again just attaches. Inside tmux it switches to the session instead of nesting one.
- `wag feature-a docs` adds the repo and one lazygit pane for it; the panes on the right are re-balanced.
- `wag feature-a web --rm` closes web's lazygit pane, then removes the worktree.
- Copilot gets `WAG_FEATURE` and `WAG_FEATURE_DIR` in its environment (see [copilot.md](copilot.md)).

```yaml
hooks:
  remove:
    # Close this worktree's lazygit pane in the feature's tmux session (see start.tmux below).
    # Never closes the pane you are running wag from, and does nothing when tmux is not running.
    - run: |
        command -v tmux >/dev/null 2>&1 || exit 0
        tmux has-session -t "=$WAG_FEATURE" 2>/dev/null || exit 0
        tmux list-panes -s -t "=$WAG_FEATURE" -F '#{pane_id} #{@wag_wt}' | while read -r id wt; do
          [ "$wt" = "$WAG_WORKTREE" ] && [ "$id" != "$TMUX_PANE" ] && tmux kill-pane -t "$id"
        done
        tmux select-layout -t "=$WAG_FEATURE:" main-vertical 2>/dev/null
        exit 0

start:
  tmux:
    - run: |
        s="$WAG_FEATURE"
        t="=$s:"
        if ! tmux has-session -t "=$s" 2>/dev/null; then
          tmux new-session -d -s "$s" -c "$WAG_FEATURE_DIR" \
            -e WAG_FEATURE="$s" -e WAG_FEATURE_DIR="$WAG_FEATURE_DIR" copilot
        fi
        have=$(tmux list-panes -t "$t" -F '#{@wag_wt}')
        printf '%s\n' "$WAG_WORKTREES" | while IFS= read -r wt; do
          [ -n "$wt" ] || continue
          printf '%s\n' "$have" | grep -Fqx "$wt" && continue
          pane=$(tmux split-window -t "$t" -c "$wt" -P -F '#{pane_id}' lazygit)
          tmux set-option -p -t "$pane" @wag_wt "$wt"
        done
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
tmux's `main-vertical` layout keeps the first pane, Copilot, on the left and stacks the others evenly on the right.

## Layout B: one window per repo

```text
tmux session "feature-a"      windows:  [api]  web  docs
┌─────────────────────────────┬─────────────────────────────┐
│ copilot                     │ lazygit                     │
│                             │                             │
│ runs in                     │ runs in                     │
│ ~/projects/feature-a/       │ ~/projects/feature-a/       │
│   api-feature-a             │   api-feature-a             │
│                             │                             │
└─────────────────────────────┴─────────────────────────────┘
```

- Each repo gets a window named after it, with its own Copilot on the left and lazygit on the right.
- The first repo's window is selected when the session opens.
- Running wag again with a new repo adds a window for it; repos that already have one are left alone.
- `wag feature-a web --rm` closes the `web` window, unless you are running wag from inside it.

```yaml
hooks:
  remove:
    # Close the repo's window, unless you are running wag from inside it.
    - run: |
        command -v tmux >/dev/null 2>&1 || exit 0
        w="=$WAG_FEATURE:=$WAG_REPO"
        if tmux list-panes -t "$w" -F '#{pane_id}' 2>/dev/null | grep -Fqx "${TMUX_PANE:-none}"; then
          echo "Not closing tmux window $WAG_REPO: you are in it." >&2
          exit 0
        fi
        tmux kill-window -t "$w" 2>/dev/null
        exit 0

start:
  tmux:
    - run: |
        s="$WAG_FEATURE"
        printf '%s\n' "$WAG_WORKTREES" | while IFS= read -r wt; do
          [ -n "$wt" ] || continue
          b=$(basename "$wt"); w=${b%-"$s"}
          if ! tmux has-session -t "=$s" 2>/dev/null; then
            tmux new-session -d -s "$s" -n "$w" -c "$wt" -e WAG_FEATURE="$s" copilot
          elif tmux list-windows -t "=$s" -F '#W' | grep -Fqx "$w"; then
            continue
          else
            tmux new-window -t "=$s:" -n "$w" -c "$wt" -e WAG_FEATURE="$s" copilot
          fi
          tmux split-window -h -l 50% -t "=$s:=$w" -c "$wt" lazygit
          tmux select-pane -t "=$s:=$w.0"
        done
        first=$(basename "$(printf '%s\n' "$WAG_WORKTREES" | head -n 1)")
        tmux select-window -t "=$s:=${first%-"$s"}"
        if [ -n "$TMUX" ]; then tmux switch-client -t "=$s"
        elif [ -t 0 ]; then tmux attach -t "=$s"
        else echo "tmux session $s is ready: tmux attach -t $s" >&2
        fi

autostart: [tmux]
```

## Day to day

```bash
wag feature-a api web          # create (if needed) and open the session
wag feature-a api web --no-start   # create without opening tmux
wag feature-a docs             # add a repo; Layout A adds a lazygit pane, Layout B a window
wag feature-a web --rm         # close its pane or window, then remove the worktree
tmux kill-session -t feature-a # close the whole session when you are done
```

Useful tmux keys, after your prefix (`Ctrl-b` by default):

| Keys | Does |
|---|---|
| `z` | Zoom the current pane to full size, and back. |
| `o` or arrow keys | Move between panes. |
| `n` / `p`, or the window number | Next / previous window (Layout B). |
| `s` | Pick a session, to jump between features. |
| `d` | Detach. `wag feature-a api` or `tmux attach -t feature-a` brings you back. |

wag never closes the whole session by itself. You might be running wag from inside that session, and closing
it would stop wag halfway through removing your worktrees. Close it with `tmux kill-session -t feature-a`
when you are done.

## Changing the layout

The profiles are plain shell, so you can change them:

- **Other split.** Change `main-pane-width 50%` (Layout A) or `-l 50%` (Layout B), for example to `60%`.
- **Other programs.** Replace `copilot` or `lazygit` with any command, such as `nvim`, `gitui` or a shell.
- **An extra shell pane.** In Layout B, add `tmux split-window -v -t "=$s:=$w.1" -c "$wt"` after the lazygit line.
- **Only sometimes.** Remove `autostart: [tmux]` and open tmux with `wag feature-a api +tmux` when you want it.

## How the examples are tested

Both layouts were run with tmux 3.4 in WSL, using stand-ins for `copilot` and `lazygit`. Each check below passed:
the first call creates the expected panes or windows, a second call adds nothing, a new repo adds exactly one
pane or window, Copilot starts in the right folder, removing a repo closes only its pane or window, the pane or
window you are in is never closed, and the remove hooks exit cleanly when no session exists.
