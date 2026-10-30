# AI agents

wag works with any AI agent CLI, such as GitHub Copilot CLI, Claude Code, Codex CLI, Gemini CLI or aider.
It does not know or configure any of them: wag only prepares the worktrees, and then you, or a
[start profile](configuration.md#start-profiles), start the agent.

## One agent for all repos, or one per repo

- **For all repos:** start the agent in the feature folder (`~/projects/feature-a`). It sees every worktree of
  the feature, which suits changes that span repos.
- **Per repo:** start the agent in one worktree. It sees only that repo.

By hand:

```bash
cd ~/projects/feature-a && claude      # all repos of feature-a
cd "$(wag feature-a api)" && copilot   # only api
```

With a start profile, so `wag feature-a api web` opens the agent for you (here in a new terminal tab of
Windows Terminal; use whatever terminal you have):

```yaml
start:
  agent:
    - wt -w 0 nt -d "$WAG_FEATURE_DIR" claude
autostart: [agent]
```

The [tmux examples](tmux.md) open one agent for all repos in a tmux session, next to a live git view.

## What the agent gets from wag

A start profile runs with these variables, and passes them on to whatever it starts:

| Variable | Value |
|---|---|
| `WAG_FEATURE` | The feature name. |
| `WAG_BRANCH` | The branch name in every repo, the same as the feature name. |
| `WAG_FEATURE_DIR` | The feature folder. |
| `WAG_REPOS` / `WAG_WORKTREES` | The repos of this call and their worktrees, one per line. |

An agent's own hooks or plugins can read them, for example to log which feature a session belongs to,
or to apply rules for one feature only.

## Settings, hooks and instructions

wag does not write agent files into your repos. Each agent keeps its own settings, hooks and permissions in its
own home folder; see that agent's documentation. Team instructions that belong to a repo, such as an `AGENTS.md`,
are ordinary files in that repo, shared through git like any other.

## Working well with agents

- **Same branch everywhere** means an agent working across repos commits to `feature-a` in each of them, and a
  plain `git push` per repo publishes it.
- **Hooks set a worktree up** the way you would by hand: `.env` files, local settings, dependencies. Add what
  a hook brings in to the repo's `.gitignore` or its local exclude list if an agent's `git add -A` must not
  commit it — wag does not exclude anything for you.
- **Feature hooks set the feature up,** once, in the folder above the worktrees: the ticket the branch names,
  a brief for the agent, a note it can append to. It sits outside every repo, so it is in no `git status` and
  no agent will commit it ([hooks](configuration.md#hooks)).
- **Main checkouts stay untouched,** and every feature has its own worktrees, so you can run another agent on
  another feature at the same time.
