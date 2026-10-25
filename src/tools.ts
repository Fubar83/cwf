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

export interface WfCtx {
  cfg: Config;
  ui: UI;
  store: Store;
  state: State;
  slug: string;
  save(): void;
}

const ok = (text: string): ToolResult => ({ ok: true, text });
const fail = (text: string): ToolResult => ({ ok: false, text });


// ───────────────────────── Frågor ─────────────────────────

/**
 * Ställer frågorna en i taget och sparar varje svar direkt.
 * Pausar användaren (eller svarar inte i tid) sparas resten som väntande frågor.
 */
export async function askQuestions(ctx: WfCtx, questions: Question[]): Promise<"answered" | "paused"> {
  const { ui, state } = ctx;
  // Lägg alla som väntande först, så att inget tappas vid avbrott.
  const pendingIds = new Set(state.pendingQuestions.map((q) => q.id));
  for (const q of questions) if (!pendingIds.has(q.id)) state.pendingQuestions.push(q);
  ctx.save();

  for (const q of questions) {
    ui.heading(`Fråga: ${q.question}`);
    ui.info(`Undersökt: ${q.investigated}`);
    q.options.forEach((o, i) => ui.info(`  ${String.fromCharCode(65 + i)}. ${o.label} – ${o.consequence}`));
    ui.info(`Rekommendation: ${q.recommendation} (${q.why})`);

    const choices = [
      ...q.options.map((o, i) => ({ value: `opt${i}`, label: `${String.fromCharCode(65 + i)}. ${o.label}` })),
      { value: "own", label: "Eget svar" },
      { value: "pause", label: "Pausa (svara senare)" },
    ];
    const r = await ui.select("Ditt svar", choices);
    if (r.kind === "timeout" || r.value === "pause") {
      ctx.save();
      return "paused";
    }
    let answer: string;
    if (r.value === "own") {
      const t = await ui.text("Skriv ditt svar:");
      if (t.kind === "timeout" || !t.value.trim()) return "paused";
      answer = t.value.trim();
    } else {
      answer = q.options[Number(r.value.slice(3))]!.label;
    }
    state.answers.push({ id: q.id, question: q.question, answer, at: new Date().toISOString() });
    state.pendingQuestions = state.pendingQuestions.filter((p) => p.id !== q.id);
    ctx.save();
  }

  ui.info("\nSammanfattning:");
  for (const q of questions) {
    const a = state.answers.findLast((x) => x.id === q.id);
    if (a) ui.info(`  • ${q.question} → ${a.answer}`);
  }
  return "answered";
}

const askUser = (ctx: WfCtx, c: Control) =>
  tool({
    name: "ask_user",
    description:
      "Ställ blockerande frågor till utvecklaren. Bara frågor du inte kan avgöra själv. Högst 5 per anrop. " +
      "Returnerar svaren, eller 'paused' – avsluta då direkt.",
    schema: z.object({ questions: z.array(Question).min(1).max(5) }),
    handler: async ({ questions }) => {
      const used = new Set(ctx.state.answers.map((a) => a.id));
      const dup = questions.find((q) => used.has(q.id));
      if (dup) return fail(`Frågan "${dup.id}" är redan besvarad: ${ctx.state.answers.find((a) => a.id === dup.id)?.answer}`);
      const res = await c.dialog(() => askQuestions(ctx, questions));
      if (res === "paused") {
        c.end({ kind: "paused", reason: "Väntar på svar på frågor." });
        return ok("paused");
      }
      const answered = questions.map((q) => `- ${q.id}: ${ctx.state.answers.findLast((a) => a.id === q.id)?.answer}`);
      return ok(`Svar:\n${answered.join("\n")}`);
    },
  });

// ───────────────────────── Plan ─────────────────────────

export function validatePlan(plan: string): string[] {
  const problems: string[] = [];
  for (const h of PLAN_HEADINGS) {
    if (!new RegExp(`^##\\s+${h}\\s*$`, "mi").test(plan)) problems.push(`Rubriken "## ${h}" saknas.`);
  }
  if (plan.length > 6000) problems.push(`Planen är ${plan.length} tecken. Högst 6000 (en sida). Korta ner den.`);
  return problems;
}

/** Feedback skrivs i editorn, en punkt per rad som börjar med "-". */
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

const FEEDBACK_TEMPLATE = `# Skriv din feedback, en punkt per rad som börjar med "-".
# Rader som börjar med # ignoreras. Spara och stäng när du är klar.
-
`;

const submitPlan = (ctx: WfCtx, c: Control) =>
  tool({
    name: "submit_plan",
    description: `Skicka planförslaget (markdown, högst en sida) till utvecklaren. Rubriker: ${PLAN_HEADINGS.join(", ")}.`,
    schema: z.object({
      plan: z.string().min(50),
      responses: z
        .array(
          z.object({
            feedback: z.number().int().min(1).describe("Feedbackpunktens nummer (1-baserat)"),
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
      if (missing.length) problems.push(`Svar saknas för feedbackpunkt ${missing.join(", ")}.`);
      if (problems.length) return fail(`Planen togs inte emot:\n${problems.map((p) => `- ${p}`).join("\n")}`);

      const version = (ctx.state.plan?.version ?? 0) + 1;
      ctx.store.write(`plan/v${version}.md`, plan);
      ctx.state.plan = { version, approved: false, feedback: [] };
      ctx.save();

      const review = await c.dialog(() => reviewPlan(ctx, plan, responses.map((r) => ({ ...r, text: fb[r.feedback - 1] ?? "" }))));
      if (review === "paused") {
        c.end({ kind: "paused", reason: "Planen väntar på granskning." });
        return ok("paused");
      }
      if (review === "approved") {
        c.end({ kind: "plan-approved" });
        return ok("Planen är godkänd. Fasen är klar – gör inget mer.");
      }
      const items = ctx.state.plan!.feedback;
      return ok(
        `Utvecklaren vill ha ändringar. Revidera planen och skicka den igen med submit_plan, ` +
          `med ett svar per punkt i responses:\n${items.map((f, i) => `${i + 1}. ${f}`).join("\n")}`,
      );
    },
  });

/**
 * Visar planen och låter utvecklaren godkänna, ge feedback eller pausa.
 * Används både av submit_plan och när wf återupptar en plan som väntar på granskning.
 */
export async function reviewPlan(
  ctx: WfCtx,
  plan: string,
  responses: { feedback: number; status: string; why: string; text: string }[] = [],
): Promise<"approved" | "feedback" | "paused"> {
  const { ui, state } = ctx;
  const version = state.plan!.version;
  ui.heading(`Planförslag v${version}`);
  ui.info(plan);
  if (responses.length) {
    ui.heading("Svar på din feedback");
    for (const r of responses) {
      ui.info(`  ${r.feedback}. ${r.status === "addressed" ? "✓ Åtgärdad" : "✗ Avböjd"}: ${r.text}\n     ${r.why}`);
    }
  }
  for (;;) {
    const choice = await ui.select("Vad vill du göra med planen?", [
      { value: "approve", label: "Godkänn" },
      { value: "feedback", label: "Ge feedback" },
      { value: "pause", label: "Pausa" },
    ]);
    if (choice.kind === "timeout" || choice.value === "pause") return "paused";
    if (choice.value === "approve") {
      state.plan!.approved = true;
      ctx.store.write("plan/approved.md", plan);
      ctx.store.log("decisions.log", { source: "user", decision: `Plan v${version} godkänd` });
      ctx.save();
      return "approved";
    }
    const edited = await ui.editor(FEEDBACK_TEMPLATE);
    if (edited.kind === "timeout") return "paused";
    const items = parseFeedback(edited.value);
    if (!items.length) {
      ui.warn("Ingen feedback skrevs.");
      continue;
    }
    state.plan!.feedback = items;
    ctx.store.write(`plan/v${version}.feedback.md`, items.map((f, i) => `${i + 1}. ${f}`).join("\n") + "\n");
    ctx.save();
    return "feedback";
  }
}

// ───────────────────────── Bygga ─────────────────────────

const recordDecision = (ctx: WfCtx) =>
  tool({
    name: "record_decision",
    description: "Logga ett beslut du fattat själv, eller en avvikelse från planen.",
    schema: z.object({
      decision: z.string().min(3),
      why: z.string().min(3),
      deviatesFromPlan: z.boolean().default(false),
    }),
    handler: async (d) => {
      ctx.store.log("decisions.log", { source: "copilot", ...d });
      return ok("Loggat.");
    },
  });

const runGateTool = (ctx: WfCtx) =>
  tool({
    name: "run_gate",
    description: "Kör repots kvalitetskontroller (format, bygg, test, hemligheter). Ändrar aldrig kod.",
    schema: z.object({ repos: z.array(z.string()).optional() }),
    handler: async ({ repos }) => {
      const list = repos?.length ? repos.filter((r) => ctx.state.repos.includes(r)) : ctx.state.repos;
      const g = await runGate(ctx.cfg, ctx.slug, list);
      ctx.store.log("logs/gate.log", { ok: g.ok, steps: g.steps.map((s) => ({ repo: s.repo, name: s.name, ok: s.ok })) });
      return ok(`${g.ok ? "Alla kontroller gröna." : "Kontroller misslyckades."}\n${formatGate(g)}`);
    },
  });

const GENERATED = /(^|\/)(bin|obj|cdk\.out|node_modules|dist|\.terraform)\//;

/** Allt som måste stämma innan publicering. Returnerar problem som Copilot ska åtgärda. */
export async function checkReady(ctx: WfCtx, prs: PrInfo[], runChecks = true): Promise<string[]> {
  const problems: string[] = [];
  const { state, cfg, slug } = ctx;
  const prRepos = new Set(prs.map((p) => p.repo));
  for (const p of prs) {
    if (!state.repos.includes(p.repo)) problems.push(`${p.repo} ingår inte i ärendet.`);
    for (const d of p.dependsOn) if (!prRepos.has(d)) problems.push(`${p.repo} beror på ${d}, som inte har någon PR.`);
  }
  const changed: string[] = [];
  for (const repo of state.repos) {
    const wt = worktreeDir(cfg, slug, repo);
    const branch = (await git(wt, "branch", "--show-current")).trim();
    if (branch !== state.branch) {
      problems.push(`${repo}: fel branch (${branch}), ska vara ${state.branch}.`);
      continue;
    }
    if ((await gitTry(wt, "rev-parse", "-q", "--verify", "MERGE_HEAD")).code === 0) {
      problems.push(`${repo}: en merge pågår. Lös konflikterna och committa.`);
    }
    if (await isDirty(wt)) problems.push(`${repo}: det finns ocommittade ändringar. Committa eller återställ dem med git restore.`);
    if (!(await remoteIsAncestor(wt, state.branch))) problems.push(`${repo}: redan pushade commits har skrivits om. Gör om ändringen som en ny commit.`);
    const ahead = await commitsAhead(wt);
    if (ahead > 0) changed.push(repo);
    if (ahead > 0 && !prRepos.has(repo)) problems.push(`${repo} har ${ahead} commits men ingen PR-text.`);
    if (ahead === 0 && prRepos.has(repo)) problems.push(`${repo} har PR-text men inga commits.`);
    if (ahead > 0) {
      const base = await defaultBranch(wt);
      const files = (await git(wt, "diff", "--name-only", "--diff-filter=AM", `origin/${base}...HEAD`)).split("\n").filter(Boolean);
      for (const f of files) {
        if (GENERATED.test(f)) problems.push(`${repo}: genererad fil ${f} är committad. Ta bort den och lägg mappen i .gitignore.`);
        else if (existsSync(join(wt, f)) && statSync(join(wt, f)).size > 5_000_000) problems.push(`${repo}: ${f} är större än 5 MB.`);
      }
    }
  }
  if (!changed.length) problems.push("Inga commits i något repo. Använd report_no_change om ingen ändring behövs.");
  if (!problems.length && runChecks) {
    const g = await runGate(cfg, slug, changed);
    if (!g.ok) problems.push(`Kontrollerna är inte gröna:\n${formatGate(g)}`);
  }
  return problems;
}

const readyForPr = (ctx: WfCtx, c: Control) =>
  tool({
    name: "ready_for_pr",
    description:
      "Signalera att arbetet är klart. Ange PR-titel och PR-text för varje repo med commits, " +
      "och dependsOn om en PR måste mergas efter en annan. wf kontrollerar och kör gate innan utvecklaren tillfrågas.",
    schema: z.object({ prs: z.array(PrInfo).min(1) }),
    handler: async ({ prs }) => {
      const problems = await checkReady(ctx, prs);
      if (problems.length) return fail(`Inte redo:\n${problems.map((p) => `- ${p}`).join("\n")}\nÅtgärda och anropa igen.`);
      c.end({ kind: "ready", prs });
      return ok("Klart. wf tar över publiceringen – gör inget mer.");
    },
  });

const reportBlocked = (c: Control) =>
  tool({
    name: "report_blocked",
    description: "Använd när arbetet inte kan fortsätta, t.ex. ett krav som motsäger sig självt eller något som saknas helt.",
    schema: z.object({ reason: z.string().min(10) }),
    handler: async ({ reason }) => {
      c.end({ kind: "blocked", reason });
      return ok("Noterat. Avsluta nu.");
    },
  });

const reportNoChange = (c: Control) =>
  tool({
    name: "report_no_change",
    description: "Använd när ärendet inte kräver någon kodändring. Förklara varför.",
    schema: z.object({ reason: z.string().min(10) }),
    handler: async ({ reason }) => {
      c.end({ kind: "no-change", reason });
      return ok("Noterat. Avsluta nu.");
    },
  });

export const planTools = (ctx: WfCtx) => (c: Control) => [askUser(ctx, c), submitPlan(ctx, c), reportBlocked(c)];

export const buildTools = (ctx: WfCtx) => (c: Control) => [
  askUser(ctx, c),
  recordDecision(ctx),
  runGateTool(ctx),
  readyForPr(ctx, c),
  reportBlocked(c),
  reportNoChange(c),
];
