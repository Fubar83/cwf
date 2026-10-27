# wag

**W**orktrees, **A**gents, **G**it. One command gives a feature its own folder, with a git worktree per repo,
all on a branch with the feature's name. Run any AI agent, editor or tool in it: wag only manages the worktrees
and branches, and runs the hooks and start commands you configure.

```text
~/projects/
├── api/                          main checkout
├── web/                          main checkout
└── feature-a/
    ├── api-feature-a/            worktree, branch feature-a, tracking origin/feature-a
    └── web-feature-a/            worktree, branch feature-a, tracking origin/feature-a
```

```bash
wag feature-a api web          # create the worktrees, run your start profiles, print the feature folder
wag feature-a api              # one repo: prints its worktree, so cd "$(wag feature-a api)" works
wag                            # list features
wag feature-a --rm             # remove the feature's worktrees (branches are kept)
```

## Requirements

- **git 2.17 or later**, able to fetch from your repos' `origin` remotes (SSH keys or a credential helper,
  whatever you already use). wag runs `git fetch`; pushing is up to you.
- **Node.js 22 or later**, because wag is a Node script.

That is all. wag's only package dependency, `yaml`, is installed with it. Anything else, such as tmux, lazygit
or an AI agent CLI, is only needed if your own config starts it.

## Install

```bash
npm install --global @fub4r/wag
```

Or from source:

```bash
git clone https://github.com/Fubar83/wag.git
cd wag
pnpm run global                       # or: npm install && npm install --global .
```

With pnpm, if its global bin folder is not on your PATH yet, run `pnpm setup` once and open a new terminal.
wag works on Windows, Linux and macOS.

Then create your config from one of the [examples](examples), for example
[minimal.yaml](examples/minimal.yaml), as `~/.config/wag/config.yaml`. `wag --help` shows the path it reads.

## Documentation

- [Using wag](docs/usage.md): the layout, every command, a full session with real output, staying in sync with
  origin and handling merge conflicts, and what wag guarantees.
- [Configuration](docs/configuration.md): the config file in your home folder, hooks that copy local files or run
  commands, and start profiles.
- [Agents](docs/agents.md): running AI agent CLIs on a whole feature or on one repo.
- [tmux](docs/tmux.md): an example tmux session per feature, with an agent and lazygit side by side.
- [Examples](examples): `minimal.yaml` (works everywhere) and `config.yaml` (with the tmux example).

## In short

- **Same branch name everywhere**, tracking `origin/<feature>`, so a plain `git push` just works.
- **Nothing is guessed.** A missing origin, a failed fetch, a bad name, a branch checked out elsewhere,
  a diverged branch or a config mistake stops wag before it changes anything.
- **All or nothing.** If one repo fails, everything that call created is rolled back. Removing checks every
  worktree before removing any.
- **Local files stay local.** Files copied in by hooks are excluded from git, so they are never committed.
- **Configured in your home folder**, in `~/.config/wag/config.yaml`. Nothing is needed in the repos.

## Development

```bash
pnpm install      # or npm install
pnpm test         # or npm test
```

The tests run wag against real local git repos with bare origins, and check that every config in `examples/`
and `docs/` is valid. No network needed.
