# AGENTS.md – template for repos that cwf works in

Copilot reads this file in every repo and follows it. cwf itself knows nothing about the
repo's code, so everything repo-specific belongs here. Adapt it and check it in at the repo root.

## About the repo
- What the repo does, in two or three sentences.
- The most important directories, e.g. `src/Api/`, `src/Domain/`, `tests/`, `infra/`.

## Patterns to follow
- Pointers to examples that new code should imitate, e.g. "New endpoints: see `src/Api/Invoices/`".
- Patterns that are deprecated and must not be copied.

## Code and tests
- Every change has tests. Existing tests are not removed or weakened.
- Run `dotnet test` (or the equivalent) before calling ready_for_pr.

## Commits
- One commit per task.
- Format: Conventional Commits, e.g. `feat(invoices): add CSV export`.
- Write commit messages in English (or your team's language, be consistent).

## PR text
- Summary, what changed, how it was tested.
- Name the risks and anything the reviewer should look at closely.

## ADRs
- Create an ADR in `docs/adr/` when a decision affects architecture, security or operations.
- MADR format, status always `Proposed`. The number is the next free one.
