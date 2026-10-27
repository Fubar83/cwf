# cwf

Takes a Jira issue to a pull request with GitHub Copilot.

cwf is a thin orchestrator. Copilot makes the content decisions (plan, code, tests, commits, PR text)
based on each repo's `AGENTS.md`. cwf owns the workspace, the flow, the checks, publishing and the guardrails.

## Getting started

```bash
pnpm run global                                       # pnpm install + pnpm add --global .
cp cwf.config.example.yaml ~/.config/cwf/config.yaml  # then fill it in
cwf run VFS-1350
```

`pnpm run global` installs `cwf` globally, so it works from any folder. If pnpm's global bin
directory is not on your PATH yet, run `pnpm setup` once and open a new terminal.

Requirements: Node 22+, `git`, `gh` (logged in), `copilot` (Copilot CLI, logged in), `twg` (logged in).

## wt: feature worktrees for one repo

One command puts a feature branch in its own git worktree, so you can start Copilot there by hand.

```bash
wt                            # all features
wt feature-a                  # the worktrees of feature-a
wt feature-a repo1            # create ~/projects/feature-a/repo1-feature-a if missing, print its path
cd "$(wt feature-a repo1)"    # create-or-enter in one step
wt feature-a repo1 --rm       # remove it; refuses if there are uncommitted changes (--force discards them)
```

The branch is kept on removal. `WT_PROJECTS` sets the projects folder (default `~/projects`).
Only the path goes to stdout; messages go to stderr.

Rules, so nothing fails halfway:
- The branch has the same name locally and on origin, so a plain `git push` from the worktree updates `origin/<feature>`.
- An existing `origin/<feature>` is picked up, not recreated from main.
- Stops with an error, and changes nothing, when: origin is missing or cannot be fetched, the name is invalid,
  the branch is checked out elsewhere, or the local branch has diverged from origin.
- A create that fails midway is rolled back.

## Commands

| Command | What it does |
|---|---|
| `cwf run <KEY> [repos…]` | Starts or continues an issue. Without repos, the project's repos from the settings are used. |
| `cwf run <KEY> -m "text"` | Adds a note for Copilot. Required to continue a blocked issue. |
| `cwf run <KEY> --no-publish` | Stops before publishing. |
| `cwf run <KEY> --aic-limit 500` | AI-credit cap for this run only. |
| `cwf clean` | Removes issues whose PRs are merged or closed. Archives the state and decisions. |

Exit codes: `0` done · `10` paused · `20` blocked · `1` error.

## The flow

1. **Prepare** (cwf): preflight checks, lock, one git worktree per repo on the branch `vfs-1350-short-title`,
   merge of the default branch, and a check whether the issue changed since the last run.
2. **Plan** (Copilot, read-only): reads the issue and the Confluence pages linked from it,
   asks blocking questions and proposes a plan of at most one page.
   You **approve**, give **feedback** in your editor (Copilot must answer every point) or **pause**.
3. **Build** (Copilot, write mode): one commit per task, runs the checks until everything is green,
   calls `ready_for_pr`. cwf verifies that everything is committed and runs the checks itself.
4. **Publish**: you see the commits, the changed lines and deviations from the plan, and choose
   **draft**, **ready for review** or **pause**. cwf pushes and creates the PRs in dependency order.

If you pause, or do not answer a question within `waitForUserMin`, everything is saved. The next
`cwf run` starts with the unanswered questions. Copilot sessions are never resumed: the files in `.cwf/` are the truth.

## Directory layout

```
projects/
├── vfs-api/                  main checkout
├── vfs-1350/
│   ├── .cwf/                 cwf's state (Copilot may not write here)
│   │   ├── state.json        phase, answers, plan, publishing
│   │   ├── issue.json        the issue from twg
│   │   ├── plan/v1.md …      plan versions, feedback and approved.md
│   │   ├── decisions.log     decisions and deviations
│   │   ├── usage.log         AI credits per run
│   │   └── logs/
│   └── vfs-api/              worktree on the issue's branch
└── .cwf-archive/             issues archived by cwf clean
```

## Guardrails

- **YOLO permissions.** Copilot runs with permission requests auto-approved, so an unattended run never
  stalls waiting for a human. The guardrails below still apply, because they run before every tool call.
- **Policy** for every built-in tool call (`src/policy.ts`), enforced in `onPreToolUse`.
  The plan phase only allows read-only commands. Always denied: `git push`, `rebase`, `reset --hard`,
  `checkout`, `stash`, `--no-verify`, writing `gh` commands, `gh api`, network tools (`curl`, `wget`, `ssh`, …),
  writing `twg`, secrets, command substitution, and writes to `.cwf/` or outside the issue.
- **Warnings** to Copilot about `@ts-ignore`, skipped tests, suppressed warnings, and similar.
- **Hang watchdog** that stops a session that goes silent while cwf waits for you.
- **AI-credit cap** per run. When it is reached, cwf asks whether to raise it.
- **Merge, never rebase or force push.** Conflicts are resolved in the next build round.
- **No duplicates**: every publish step is saved; the PR text is only updated between
  `<!-- cwf:start -->` and `<!-- cwf:end -->`.
- Before publishing: no uncommitted code, no merge in progress, no rewritten pushed commits,
  no generated files (`bin/`, `obj/`, `dist/`, `node_modules/`) and no files over 5 MB.

## Tests

```bash
pnpm run typecheck
pnpm test
```

The tests run the whole flow with `FakeAgent` against real local git repos and a fake `gh`,
without network and without cost.

## Before the first real run

The SDK adapter (`src/agent/copilot.ts`) was written against the documentation and has not been run against
the real SDK yet. Places to check are marked `VERIFY`.

1. Pin `@github/copilot-sdk` and the Copilot CLI to exact versions in `package.json`.
2. Hooks: that `onPreToolUse` receives `toolName`/`toolArgs`, and that the tool names for shell and file writes
   match `classify()` in `src/policy.ts`. Log a few real calls and adjust.
3. `onPermissionRequest`: that auto-approval is what you want (see YOLO above).
4. `assistant.usage` and `session.rpc.usage.getMetrics()`: compare cwf's AIC with `/usage` over three sessions.
5. `customAgents` with a different model (`gpt-6-luna`), and that both models are enabled for your plan.
6. How long a tool call can stay open while cwf waits for you.
7. `twg context jira workitem`: that linked Confluence pages and the description come along.

## Not in the first version

Jira comments, CI follow-up and review comments, sub-items, a shared team settings file,
`cwf status`, and switching session when the context is full. These can be added once the core
has run on a few real issues.
