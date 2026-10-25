import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import { defineTool as tool, type ToolResult } from "./agent/types.ts";
import type { Config } from "./config.ts";
import { git, gitTry } from "./exec.ts";
import { formatGate, runGate } from "./gate.ts";
import { PLAN_HEADINGS } from "./prompts.ts";
import type { Control } from "./runner.ts";
import { PrInfo, Question, type State, type Store } from "./state.ts";
import type { UI } from "./ui.ts";
import { commitsAhead, defaultBranch, isDirty, remoteIsAncestor, worktreeDir } from "./workspace.ts";

export interface CwfCtx {
  cfg: Config;
  ui: UI;
  store: Store;
  state: State;
  slug: string;
  save(): void;
}

const ok = (text: string): ToolResult => ({ ok: true, text });
const fail = (text: string): ToolResult => ({ ok: false, text });

// ───────────────────────── Questions ─────────────────────────

/**
 * Asks the questions one at a time and saves each answer immediately.
 * If the user pauses (or does not answer in time), the rest are kept as pending questions.
 */
export async function askQuestions(ctx: CwfCtx, questions: Question[]): Promise<"answered" | "paused"> {
  const { ui, state } = ctx;
  // Add all of them as pending first, so nothing is lost on an interruption.
  const pendingIds = new Set(state.pendingQuestions.map((q) => q.id));
  for (const q of questions) if (!pendingIds.has(q.id)) state.pendingQuestions.push(q);
  ctx.save();

  for (const q of questions) {
    ui.heading(`Question: ${q.question}`);
    ui.info(`Investigated: ${q.investigated}`);
    q.options.forEach((o, i) => ui.info(`  ${String.fromCharCode(65 + i)}. ${o.label} – ${o.consequence}`));
    ui.info(`Recommendation: ${q.recommendation} (${q.why})`);

    const choices = [
      ...q.options.map((o, i) => ({ value: `opt${i}`, label: `${String.fromCharCode(65 + i)}. ${o.label}` })),
      { value: "own", label: "Own answer" },
      { value: "pause", label: "Pause (answer later)" },
    ];
    const r = await ui.select("Your answer", choices);
    if (r.kind === "timeout" || r.value === "pause") {
      ctx.save();
      return "paused";
    }
    let answer: string;
    if (r.value === "own") {
      const t = await ui.text("Write your answer:");
      if (t.kind === "timeout" || !t.value.trim()) return "paused";
      answer = t.value.trim();
    } else {
      answer = q.options[Number(r.value.slice(3))]!.label;
    }
    state.answers.push({ id: q.id, question: q.question, answer, at: new Date().toISOString() });
    state.pendingQuestions = state.pendingQuestions.filter((p) => p.id !== q.id);
    ctx.save();
  }

  ui.info("\nSummary:");
  for (const q of questions) {
    const a = state.answers.findLast((x) => x.id === q.id);
    if (a) ui.info(`  • ${q.question} → ${a.answer}`);
  }
  return "answered";
}

const askUser = (ctx: CwfCtx, c: Control) =>
  tool({
    name: "ask_user",
    description:
      "Ask the developer blocking questions. Only questions you cannot decide yourself. At most 5 per call. " +
      "Returns the answers, or 'paused' – then end immediately.",
    schema: z.object({ questions: z.array(Question).min(1).max(5) }),
    handler: async ({ questions }) => {
      const used = new Set(ctx.state.answers.map((a) => a.id));
      const dup = questions.find((q) => used.has(q.id));
      if (dup) return fail(`The question "${dup.id}" is already answered: ${ctx.state.answers.find((a) => a.id === dup.id)?.answer}`);
      const res = await c.dialog(() => askQuestions(ctx, questions));
      if (res === "paused") {
        c.end({ kind: "paused", reason: "Waiting for answers to questions." });
        return ok("paused");
      }
      const answered = questions.map((q) => `- ${q.id}: ${ctx.state.answers.findLast((a) => a.id === q.id)?.answer}`);
      return ok(`Answers:\n${answered.join("\n")}`);
    },
  });

// ───────────────────────── Plan ─────────────────────────

export function validatePlan(plan: string): string[] {
  const problems: string[] = [];
  for (const h of PLAN_HEADINGS) {
    if (!new RegExp(`^##\\s+${h}\\s*$`, "mi").test(plan)) problems.push(`The heading "## ${h}" is missing.`);
  }
  if (plan.length > 6000) problems.push(`The plan is ${plan.length} characters. At most 6000 (one page). Shorten it.`);
  return problems;
}

/** Feedback is written in the editor, one point per line starting with "-". */
export function parseFeedback(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || /^\s*[-*]\s*$/.test(line)) continue;
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (m?.[1]?.trim()) items.push(m[1].trim());
    else if (line.trim() && items.length) items[items.length - 1] += ` ${line.trim()}`;
    else if (line.trim()) items.push(line.trim());
  }
  return items;
}

const FEEDBACK_TEMPLATE = `# Write your feedback, one point per line starting with "-".
# Lines starting with # are ignored. Save and close when you are done.
-
`;

const submitPlan = (ctx: CwfCtx, c: Control) =>
  tool({
    name: "submit_plan",
    description: `Submit the plan proposal (markdown, at most one page) to the developer. Headings: ${PLAN_HEADINGS.join(", ")}.`,
    schema: z.object({
      plan: z.string().min(50),
      responses: z
        .array(
          z.object({
            feedback: z.number().int().min(1).describe("The feedback point's number (1-based)"),
            status: z.enum(["addressed", "declined"]),
            why: z.string().min(3),
          }),
        )
        .default([]),
    }),
    handler: async ({ plan, responses }) => {
      const problems = validatePlan(plan);
      const fb = ctx.state.plan?.feedback ?? [];
      const missing = fb.map((_, i) => i + 1).filter((n) => !responses.some((r) => r.feedback === n));
      if (missing.length) problems.push(`No response for feedback point ${missing.join(", ")}.`);
      if (problems.length) return fail(`The plan was not accepted:\n${problems.map((p) => `- ${p}`).join("\n")}`);

      const version = (ctx.state.plan?.version ?? 0) + 1;
      ctx.store.write(`plan/v${version}.md`, plan);
      ctx.state.plan = { version, approved: false, feedback: [] };
      ctx.save();

      const review = await c.dialog(() => reviewPlan(ctx, plan, responses.map((r) => ({ ...r, text: fb[r.feedback - 1] ?? "" }))));
      if (review === "paused") {
        c.end({ kind: "paused", reason: "The plan is waiting for review." });
        return ok("paused");
      }
      if (review === "approved") {
        c.end({ kind: "plan-approved" });
        return ok("The plan is approved. The phase is done – do nothing more.");
      }
      const items = ctx.state.plan!.feedback;
      return ok(
        `The developer wants changes. Revise the plan and submit it again with submit_plan, ` +
          `with one answer per point in responses:\n${items.map((f, i) => `${i + 1}. ${f}`).join("\n")}`,
      );
    },
  });

/**
 * Shows the plan and lets the developer approve it, give feedback or pause.
 * Used both by submit_plan and when cwf resumes a plan that is waiting for review.
 */
export async function reviewPlan(
  ctx: CwfCtx,
  plan: string,
  responses: { feedback: number; status: string; why: string; text: string }[] = [],
): Promise<"approved" | "feedback" | "paused"> {
  const { ui, state } = ctx;
  const version = state.plan!.version;
  ui.heading(`Plan proposal v${version}`);
  ui.info(plan);
  if (responses.length) {
    ui.heading("Responses to your feedback");
    for (const r of responses) {
      ui.info(`  ${r.feedback}. ${r.status === "addressed" ? "✓ Addressed" : "✗ Declined"}: ${r.text}\n     ${r.why}`);
    }
  }
  for (;;) {
    const choice = await ui.select("What do you want to do with the plan?", [
      { value: "approve", label: "Approve" },
      { value: "feedback", label: "Give feedback" },
      { value: "pause", label: "Pause" },
    ]);
    if (choice.kind === "timeout" || choice.value === "pause") return "paused";
    if (choice.value === "approve") {
      state.plan!.approved = true;
      ctx.store.write("plan/approved.md", plan);
      ctx.store.log("decisions.log", { source: "user", decision: `Plan v${version} approved` });
      ctx.save();
      return "approved";
    }
    const edited = await ui.editor(FEEDBACK_TEMPLATE);
    if (edited.kind === "timeout") return "paused";
    const items = parseFeedback(edited.value);
    if (!items.length) {
      ui.warn("No feedback was written.");
      continue;
    }
    state.plan!.feedback = items;
    ctx.store.write(`plan/v${version}.feedback.md`, items.map((f, i) => `${i + 1}. ${f}`).join("\n") + "\n");
    ctx.save();
    return "feedback";
  }
}

// ───────────────────────── Build ─────────────────────────

const recordDecision = (ctx: CwfCtx) =>
  tool({
    name: "record_decision",
    description: "Log a decision you made yourself, or a deviation from the plan.",
    schema: z.object({
      decision: z.string().min(3),
      why: z.string().min(3),
      deviatesFromPlan: z.boolean().default(false),
    }),
    handler: async (d) => {
      ctx.store.log("decisions.log", { source: "copilot", ...d });
      return ok("Logged.");
    },
  });

const runGateTool = (ctx: CwfCtx) =>
  tool({
    name: "run_gate",
    description: "Run the repos' quality checks (format, build, test, secrets). Never changes code.",
    schema: z.object({ repos: z.array(z.string()).optional() }),
    handler: async ({ repos }) => {
      const list = repos?.length ? repos.filter((r) => ctx.state.repos.includes(r)) : ctx.state.repos;
      const g = await runGate(ctx.cfg, ctx.slug, list);
      ctx.store.log("logs/gate.log", { ok: g.ok, steps: g.steps.map((s) => ({ repo: s.repo, name: s.name, ok: s.ok })) });
      return ok(`${g.ok ? "All checks are green." : "Checks failed."}\n${formatGate(g)}`);
    },
  });

const GENERATED = /(^|\/)(bin|obj|dist|node_modules|\.terraform)\//;

/** Everything that must hold before publishing. Returns problems for Copilot to fix. */
export async function checkReady(ctx: CwfCtx, prs: PrInfo[], runChecks = true): Promise<string[]> {
  const problems: string[] = [];
  const { state, cfg, slug } = ctx;
  const prRepos = new Set(prs.map((p) => p.repo));
  for (const p of prs) {
    if (!state.repos.includes(p.repo)) problems.push(`${p.repo} is not part of the issue.`);
    for (const d of p.dependsOn) if (!prRepos.has(d)) problems.push(`${p.repo} depends on ${d}, which has no PR.`);
  }
  const changed: string[] = [];
  for (const repo of state.repos) {
    const wt = worktreeDir(cfg, slug, repo);
    const branch = (await git(wt, "branch", "--show-current")).trim();
    if (branch !== state.branch) {
      problems.push(`${repo}: wrong branch (${branch}), should be ${state.branch}.`);
      continue;
    }
    if ((await gitTry(wt, "rev-parse", "-q", "--verify", "MERGE_HEAD")).code === 0) {
      problems.push(`${repo}: a merge is in progress. Resolve the conflicts and commit.`);
    }
    if (await isDirty(wt)) problems.push(`${repo}: there are uncommitted changes. Commit them or restore them with git restore.`);
    if (!(await remoteIsAncestor(wt, state.branch))) problems.push(`${repo}: already pushed commits have been rewritten. Redo the change as a new commit.`);
    const ahead = await commitsAhead(wt);
    if (ahead > 0) changed.push(repo);
    if (ahead > 0 && !prRepos.has(repo)) problems.push(`${repo} has ${ahead} commits but no PR text.`);
    if (ahead === 0 && prRepos.has(repo)) problems.push(`${repo} has PR text but no commits.`);
    if (ahead > 0) {
      const base = await defaultBranch(wt);
      const files = (await git(wt, "diff", "--name-only", "--diff-filter=AM", `origin/${base}...HEAD`)).split("\n").filter(Boolean);
      for (const f of files) {
        if (GENERATED.test(f)) problems.push(`${repo}: generated file ${f} is committed. Remove it and add the folder to .gitignore.`);
        else if (existsSync(join(wt, f)) && statSync(join(wt, f)).size > 5_000_000) problems.push(`${repo}: ${f} is larger than 5 MB.`);
      }
    }
  }
  if (!changed.length) problems.push("No commits in any repo. Use report_no_change if no change is needed.");
  if (!problems.length && runChecks) {
    const g = await runGate(cfg, slug, changed);
    if (!g.ok) problems.push(`The checks are not green:\n${formatGate(g)}`);
  }
  return problems;
}

const readyForPr = (ctx: CwfCtx, c: Control) =>
  tool({
    name: "ready_for_pr",
    description:
      "Signal that the work is done. Give a PR title and PR text for every repo with commits, " +
      "and dependsOn if one PR must be merged after another. cwf checks and runs the gate before the developer is asked.",
    schema: z.object({ prs: z.array(PrInfo).min(1) }),
    handler: async ({ prs }) => {
      const problems = await checkReady(ctx, prs);
      if (problems.length) return fail(`Not ready:\n${problems.map((p) => `- ${p}`).join("\n")}\nFix it and call again.`);
      c.end({ kind: "ready", prs });
      return ok("Done. cwf takes over publishing – do nothing more.");
    },
  });

const reportBlocked = (c: Control) =>
  tool({
    name: "report_blocked",
    description: "Use when the work cannot continue, e.g. a requirement that contradicts itself or something that is missing entirely.",
    schema: z.object({ reason: z.string().min(10) }),
    handler: async ({ reason }) => {
      c.end({ kind: "blocked", reason });
      return ok("Noted. End now.");
    },
  });

const reportNoChange = (c: Control) =>
  tool({
    name: "report_no_change",
    description: "Use when the issue requires no code change. Explain why.",
    schema: z.object({ reason: z.string().min(10) }),
    handler: async ({ reason }) => {
      c.end({ kind: "no-change", reason });
      return ok("Noted. End now.");
    },
  });

export const planTools = (ctx: CwfCtx) => (c: Control) => [askUser(ctx, c), submitPlan(ctx, c), reportBlocked(c)];

export const buildTools = (ctx: CwfCtx) => (c: Control) => [
  askUser(ctx, c),
  recordDecision(ctx),
  runGateTool(ctx),
  readyForPr(ctx, c),
  reportBlocked(c),
  reportNoChange(c),
];
