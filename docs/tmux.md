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

## lazygit in the feature folder

The feature folder holds the worktrees but is not a git repository itself, so lazygit starts outside a repo
there. Use lazygit's recent-repositories list to switch between the feature's worktrees. If you would rather
have lazygit open the first repo directly, replace `-c "$WAG_FEATURE_DIR" lazygit` with:

```sh
-c "$(printf '%s\n' "$WAG_WORKTREES" | head -n 1)" lazygit
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

## How the example is tested

The profile was run with tmux 3.4 in WSL, using stand-ins for the agent and lazygit. It creates one session named
after the branch with two panes of equal width, the agent on the left, both in the feature folder; a second call
adds nothing; and a branch name with a dot finds its session again.
