# wag

**W**orktrees, **A**gents, **G**it. One command gives a feature its own folder, with a git worktree per repo,
all on a branch with the feature's name. Run any AI agent, editor or tool in it: wag only manages the worktrees
and branches, and runs the hooks and start commands you configure.

```text
~/projects/
├── api/                          main checkout
├── web/                          main checkout
└── feature-a/
    ├── api-feature-a/            worktree, branch feature-a, pushes to origin/feature-a
    └── web-feature-a/            worktree, branch feature-a, pushes to origin/feature-a
```

```bash
wag feature-a api web          # create the worktrees, run your start profiles, print the feature folder
wag feature-a api              # one repo: prints its worktree, so cd "$(wag feature-a api)" works
wag                            # list features
wag feature-a --rm             # remove the feature's worktrees (branches are kept)
```

## Requirements

- **git 2.17 or later** (2.37 for a plain first `git push`), able to fetch from your repos' `origin` remotes
  (SSH keys or a credential helper, whatever you already use). wag runs `git fetch`; pushing is up to you.
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
npm run global                        # npm install, then npm install --global .
```

wag works on Windows, Linux and macOS.

Then create your config from one of the [examples](examples), for example
[minimal.yaml](examples/minimal.yaml), as `~/.config/wag/config.yaml`. `wag --help` shows the path it reads.

## Documentation

- [Using wag](docs/usage.md): the layout, every command, a full session with real output, and what wag guarantees.
- [Configuration](docs/configuration.md): the config file in your home folder, hooks that copy local files or run
  commands, and start profiles.
- [Agents](docs/agents.md): running AI agent CLIs on a whole feature or on one repo.
- [tmux](docs/tmux.md): a tmux session per feature with your agent and a live git pane, in three layouts.
- [Examples](examples): `minimal.yaml` (works everywhere), `config.yaml` (tmux: agent and a git view of the whole
  feature), `tmux-per-repo.yaml` (a git pane per repo), `tmux-switch.yaml` (one repo at a time, with a terminal),
  and the scripts they use: `git-view.sh` (a live, read-only git view) and `tmux-next-repo.sh`.

## In short

- **Same branch name everywhere**, so a plain `git push` just works, the first time and after that.
- **A feature can be a path**, like `feature/tjosan-1`: the branch is that name and the folders nest to match.
  A trailing slash from tab completion is ignored, so `wag feature/testA repo1/ repo2/` works.
- **Main checkouts stay on the default branch**, and are put back on it, when clean, as a worktree is created.
- **Nothing is guessed.** A missing origin, a failed fetch, a bad name, a branch checked out elsewhere,
  a diverged branch or a config mistake stops wag before it changes anything.
- **All or nothing.** If one repo fails, everything that call created is rolled back. Removing checks every
  worktree before removing any.
- **Local files stay local.** Files copied in by hooks are excluded from git, so they are never committed.
- **Configured in your home folder**, in `~/.config/wag/config.yaml`. Nothing is needed in the repos.
  `projects` is where your main checkouts are, `features` where the feature folders go (in `projects` by default).

## Development

```bash
npm install
npm test
```

The tests run wag against real local git repos with bare origins, and check that every config in `examples/`
and `docs/` is valid. No network needed.
