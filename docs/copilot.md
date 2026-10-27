# Copilot

wag does not configure Copilot and never writes Copilot files into your repos. You start Copilot yourself, or let
a [start profile](configuration.md#start-profiles) start it, and Copilot's own settings stay in its home folder.

> The Copilot CLI is not part of wag's tests. The hook locations and fields below come from GitHub's
> [hooks reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference).
> Check `copilot --help` and the docs for your version.

## One Copilot for all repos, or one per repo

- **For all repos:** start Copilot in the feature folder (`~/projects/feature-a`). It sees every worktree of the
  feature, which suits changes that span repos. This is [tmux Layout A](tmux.md#layout-a-one-copilot-for-all-repos).
- **Per repo:** start Copilot in one worktree. It sees only that repo. This is
  [tmux Layout B](tmux.md#layout-b-one-window-per-repo).

Without tmux:

```bash
cd ~/projects/feature-a && copilot     # all repos of feature-a
cd "$(wag feature-a api)" && copilot   # only api
```

## Hooks

Copilot CLI hooks run your own commands at points in a session, for example when a session starts or before a tool runs.

- **Your hooks live in your home folder**, in `~/.copilot/hooks/*.json` (on Windows `%USERPROFILE%\.copilot\hooks\`).
  `COPILOT_HOME` moves that folder.
- **There is no command-line flag** to add hooks when starting Copilot. It loads the hook files it finds.
- Repos can also have hooks in `.github/hooks/`. wag does not use those; everything stays in your home folder.

### Hooks that know the feature

The tmux profiles start Copilot with `WAG_FEATURE` in its environment (Layout A also sets `WAG_FEATURE_DIR`).
A hook command started by Copilot should see the same variables, so one hook in your home folder can behave per
feature. This example logs every Copilot session that wag started:

`~/.copilot/hooks/wag.json`:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      { "type": "command", "bash": "~/.copilot/hooks/wag-session.sh", "timeoutSec": 10 }
    ]
  }
}
```

`~/.copilot/hooks/wag-session.sh`:

```sh
#!/bin/sh
# Only for Copilot sessions started by wag.
[ -n "$WAG_FEATURE" ] || exit 0
echo "$(date '+%Y-%m-%d %H:%M') $WAG_FEATURE $PWD" >> "$HOME/.copilot/wag-sessions.log"
```

Other events in the reference include `preToolUse` (can allow or deny a tool call), `postToolUse`,
`userPromptSubmitted`, `agentStop` and `sessionEnd`.

## Permissions

How much Copilot may do without asking is set in the Copilot CLI itself, with its command-line options or its
settings in `~/.copilot/`. Put the options in the `copilot` command of your start profile if you want them every
time. See `copilot --help` for the options in your version.

## Instructions per repo

Team instructions for agents, such as an `AGENTS.md`, belong in the repos and are shared through git like any other
file. Your personal preferences belong in Copilot's home folder. wag does not touch either.
