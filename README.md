# wag

**W**orktrees, **A**gents, **G**it. One command gives a feature its own folder, with a git worktree per repo,
all on a branch with the feature's name. Hooks bring in your local files; start profiles open your tools,
such as a tmux session with Copilot and lazygit.

```text
~/projects/
├── api/                          main checkout
├── web/                          main checkout
└── feature-a/
    ├── api-feature-a/            worktree, branch feature-a, tracking origin/feature-a
    └── web-feature-a/            worktree, branch feature-a, tracking origin/feature-a
```

```bash
wag feature-a api web          # create the worktrees, open your tools, print the feature folder
wag feature-a api              # one repo: prints its worktree, so cd "$(wag feature-a api)" works
wag                            # list features
wag feature-a --rm             # remove the feature's worktrees (branches are kept)
```

## Install

```bash
git clone https://github.com/Fubar83/wag.git
cd wag
pnpm run global
mkdir -p ~/.config/wag && cp examples/minimal.yaml ~/.config/wag/config.yaml   # then edit it
```

If pnpm's global bin folder is not on your PATH yet, run `pnpm setup` once and open a new terminal.
Requires Node 22+ and git. Works on Windows, Linux and macOS; the tmux setup needs Linux, macOS or WSL.

## Documentation

- [Using wag](docs/usage.md): the layout, every command, a full session with real output, and what wag guarantees.
- [Configuration](docs/configuration.md): the config file, hooks that copy local files or run commands, start profiles.
- [tmux](docs/tmux.md): two ready-made layouts with Copilot and lazygit, and how to change them.
- [Copilot](docs/copilot.md): one Copilot for all repos or one per repo, and Copilot hooks in your home folder.
- [Examples](examples): `minimal.yaml`, `config.yaml` (with tmux Layout A) and `tmux-windows.yaml` (Layout B).

## In short

- **Same branch name everywhere**, tracking `origin/<feature>`, so a plain `git push` just works.
- **Nothing is guessed.** A missing origin, a failed fetch, a bad name, a branch checked out elsewhere,
  a diverged branch or a config mistake stops wag before it changes anything.
- **All or nothing.** If one repo fails, everything that call created is rolled back. Removing checks every
  worktree before removing any.
- **Local files stay local.** Files copied in by hooks are excluded from git, so they are never committed.
- **Everything is configured in your home folder**, in `~/.config/wag/config.yaml`. Nothing is needed in the repos.

## Development

```bash
pnpm install
pnpm test
```

The tests run wag against real local git repos with bare origins, and check that every config in `examples/`
and `docs/` is valid. No network needed.
