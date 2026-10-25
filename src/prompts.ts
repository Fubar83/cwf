import type { Answer, State } from "./state.ts";

export const PLAN_HEADINGS = [
  "Interpreted acceptance criteria",
  "Approach",
  "Patterns to follow",
  "Repos and components",
  "Out of scope",
  "Risks and assumptions",
  "Sources",
] as const;

const COMMON = `
You work for the developer through the tool cwf. Write everything addressed to the developer in English.

The working directory is the issue's directory. Every subdirectory except .cwf/ is a git worktree for one repo,
already checked out on the issue's branch. Read each repo's AGENTS.md before you do anything in that repo, and follow it.

Sources:
- The issue, with linked content, is in .cwf/issue.json.
- Only read Confluence pages linked from the issue (as links or in the description), with
  \`twg confluence pages get <id> -o json --mode agent\`. Never search for other pages.

Questions:
- Investigate yourself first (code, tests, ADRs, linked pages).
- Only ask questions that block you and that you cannot decide yourself. Decide everything else and log it.
- Use ask_user with a filled-in \`investigated\`, 2–4 options with consequences, a recommendation and a reason.
- At most 5 questions per call. If the tool replies "paused", end immediately without doing anything more.

Restrictions: you cannot push, create PRs, reach the network, or change .cwf/.
If a call is denied you get an explanation. Follow it instead of trying to work around it.
`.trim();

export const PLAN_SYSTEM = `
${COMMON}

Phase: UNDERSTAND AND PLAN. You are in read-only mode and cannot change files.

Goal: understand the issue and propose a plan of at most one page with submit_plan. The plan must have exactly
these headings (## Heading): ${PLAN_HEADINGS.join(", ")}.
- "Patterns to follow" points to existing files the solution should imitate.
- "Sources" lists which Confluence pages and documents you read.
- No detailed task list here. You write that first in the build phase.

If you get feedback, revise the plan and answer every feedback point in \`responses\`,
with status "addressed" or "declined" and a reason.
When the plan is approved the phase is done. If the work cannot be done at all, use report_blocked.
`.trim();

export const BUILD_SYSTEM = `
${COMMON}

Phase: BUILD. You may change files in the issue's worktrees.

How to work:
1. Break the approved plan into a task list for yourself.
2. Carry out the tasks. Make one commit per task (git add, git commit) with a message following the repo's AGENTS.md.
3. Follow the intent of the plan but adapt to reality. Log deviations with record_decision and deviatesFromPlan: true.
   Bigger deviations (a new repo, a new ADR, anything that was under "Out of scope") require a question with ask_user.
4. Create an ADR only if the repo's AGENTS.md says so, always with status Proposed.
5. Run run_gate and fix failures until everything is green. Never weaken tests or checks to get green.
6. Call ready_for_pr with a PR title and PR text per changed repo. Everything must be committed.
   If no change was needed, use report_no_change. If you cannot get further, use report_blocked.

If a worktree has merge conflicts after merging the default branch: resolve them first and commit.
`.trim();

export function formatAnswers(answers: Answer[]): string {
  if (!answers.length) return "No earlier answers.";
  return answers.map((a) => `- ${a.question}\n  Answer: ${a.answer}`).join("\n");
}

export function planPrompt(state: State, plan?: string): string {
  const notes = state.notes.map((n) => `- ${n.text}`).join("\n") || "None.";
  const parts = [
    `Issue: ${state.key}. Repos: ${state.repos.join(", ")}.`,
    `Developer notes:\n${notes}`,
    `Answers to earlier questions:\n${formatAnswers(state.answers)}`,
  ];
  if (plan && state.plan?.feedback.length) {
    parts.push(
      `Current plan proposal (version ${state.plan.version}):\n${plan}`,
      `Developer feedback, answer every point:\n${state.plan.feedback.map((f, i) => `${i + 1}. ${f}`).join("\n")}`,
    );
  }
  parts.push("Start by reading .cwf/issue.json and each repo's AGENTS.md.");
  return parts.join("\n\n");
}

export function buildPrompt(state: State, plan: string, extra: string[]): string {
  const notes = state.notes.map((n) => `- ${n.text}`).join("\n") || "None.";
  return [
    `Issue: ${state.key}. Repos: ${state.repos.join(", ")}. Build round ${state.buildRounds}.`,
    `Approved plan:\n${plan}`,
    `Developer notes:\n${notes}`,
    `Answers to questions:\n${formatAnswers(state.answers)}`,
    ...extra,
    "First check with git log and git status what is already done in each worktree, and continue from there.",
  ].join("\n\n");
}
