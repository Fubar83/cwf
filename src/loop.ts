import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "./agent/types.ts";
import type { Config } from "./config.ts";
import { resolveIssue } from "./config.ts";
import { runSetup } from "./gate.ts";
import { fetchIssue, type Issue } from "./jira.ts";
import { afterTool, makePolicy } from "./policy.ts";
import { BUILD_SYSTEM, PLAN_SYSTEM, buildPrompt, planPrompt } from "./prompts.ts";
import { askPublish, publish } from "./publish.ts";
import { Budget, runSession, type End } from "./runner.ts";
import { acquireLock, Store, type State } from "./state.ts";
import { askQuestions, buildTools, checkReady, planTools, reviewPlan, type WfCtx } from "./tools.ts";
import type { UI } from "./ui.ts";
import { branchName, ensureWorktree, issueDir, mergeDefault } from "./workspace.ts";

export const EXIT = { done: 0, paused: 10, blocked: 20, error: 1 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface RunArgs {
  key: string;
  repos: string[];
  note?: string;
  noPublish?: boolean;
  aicLimit?: number;
}

export interface Deps {
  cfg: Config;
  ui: UI;
  agent: Agent;
  fetchIssue?: (cfg: Config, key: string) => Promise<Issue>;
}

export async function runIssue(args: RunArgs, deps: Deps): Promise<ExitCode> {
  const { cfg, ui, agent } = deps;
  const getIssue = deps.fetchIssue ?? fetchIssue;
  const { key, slug, project } = resolveIssue(cfg, args.key);
  const dir = issueDir(cfg, slug);
  const store = Store.forIssue(dir);
  const release = acquireLock(store);
  const budget = new Budget(args.aicLimit ?? cfg.limits.aicPerRun, cfg.models.prices);

  let state: State;
  let ctx!: WfCtx;
  const save = () => store.save(state);

  try {
    // ── 1. Förbereda ──────────────────────────────────────────
    const fresh = !store.exists();
    let issue: Issue | undefined;
    try {
      issue = await getIssue(cfg, key);
    } catch (e) {
      if (fresh) throw e;
      ui.warn(`Kunde inte hämta ärendet (${(e as Error).message}). Fortsätter med sparad kopia.`);
    }

    if (fresh) {
      const repos = args.repos.length ? args.repos : project.repos;
      state = {
        schema: 1, key, repos, branch: branchName(slug, issue!.summary), phase: "plan",
        issueHash: issue!.hash, notes: [], pendingQuestions: [], answers: [], buildRounds: 0,
        prs: [], publish: {}, aic: { total: 0 },
      };
      ui.heading(`${key}: ${issue!.summary}`);
      ui.info(`Repon: ${repos.join(", ")} · branch ${state.branch}`);
    } else {
      state = store.load();
      ui.heading(`${key} – fortsätter (${phaseName(state.phase)})`);
      if (args.repos.length && args.repos.join() !== state.repos.join()) {
        ui.warn(`Ärendet använder redan ${state.repos.join(", ")}. Angivna repon ignoreras.`);
      }
    }
    ctx = { cfg, ui, store, state, slug, save };

    if (issue) {
      store.write("issue.json", JSON.stringify(issue.raw, null, 2) + "\n");
      if (!fresh && issue.hash !== state.issueHash && state.phase !== "done") {
        const r = await ui.select("Ärendet har ändrats i Jira sedan förra körningen. Vad vill du göra?", [
          { value: "replan", label: "Gör om planen utifrån det nya ärendet" },
          { value: "continue", label: "Fortsätt som planerat" },
          { value: "pause", label: "Pausa" },
        ]);
        if (r.kind === "timeout" || r.value === "pause") return EXIT.paused;
        if (r.value === "replan") {
          state.phase = "plan";
          state.plan = undefined;
          state.notes.push({ at: now(), text: "Ärendet har ändrats i Jira. Läs om det och gör en ny plan." });
        }
      }
      state.issueHash = issue.hash;
    }

    if (args.note) state.notes.push({ at: now(), text: args.note });

    if (state.phase === "blocked") {
      if (!args.note) {
        ui.warn(`Blockerat: ${state.blockedReason}`);
        ui.info(`Lös det och kör igen med en anteckning: wf run ${key} -m "..."`);
        return EXIT.blocked;
      }
      state.phase = state.plan?.approved ? "build" : "plan";
      state.buildRounds = 0;
      state.blockedReason = undefined;
    }
    save();

    for (const repo of state.repos) {
      const existed = existsSync(join(dir, repo, ".git"));
      await ensureWorktree(cfg, slug, repo, state.branch);
      if (!existed) {
        const err = await runSetup(cfg, slug, repo);
        if (err) ui.warn(`Setup: ${err}`);
      }
    }

    // ── Obesvarade frågor från förra gången ──────────────────
    if (state.pendingQuestions.length) {
      ui.info(`Du har ${state.pendingQuestions.length} obesvarade frågor från förra gången.`);
      if ((await askQuestions(ctx, [...state.pendingQuestions])) === "paused") return EXIT.paused;
    }

    const policyFor = (phase: "plan" | "build") => makePolicy({ phase, issueDir: dir });
    const log = (entry: Record<string, unknown>) => store.log("logs/session.log", entry);
    const extra: string[] = [];

    for (;;) {
      // ── 2. Förstå och planera ────────────────────────────────
      if (state.phase === "plan") {
        // En plan som väntar på granskning visas direkt, utan ny session.
        const waiting = currentPlan(store, state);
        if (state.plan && !state.plan.approved && !state.plan.feedback.length && waiting) {
          const r = await reviewPlan(ctx, waiting);
          if (r === "paused") return EXIT.paused;
          if (r === "approved") {
            state.phase = "build";
            save();
            continue;
          }
        }
        ui.heading(state.plan?.feedback.length ? "Copilot reviderar planen…" : "Copilot läser ärendet och tar fram en plan…");
        const end = await runSession(
          agent,
          { model: cfg.models.main, researcherModel: cfg.models.researcher, cwd: dir, systemPrompt: PLAN_SYSTEM, policy: policyFor("plan") },
          planTools(ctx),
          { prompt: planPrompt(state, currentPlan(store, state)), budget, idleMs: cfg.limits.idleTimeoutMin * 60_000, log },
        );
        const next = await handleCommon(end, ctx, budget);
        if (next === "retry") continue;
        if (next !== undefined) return next;
        if (end.kind === "plan-approved") {
          state.phase = "build";
          save();
          continue;
        }
        if (end.kind === "gave-up") {
          ui.warn(end.reason);
          return EXIT.paused;
        }
        throw new Error(`Oväntat slut på planfasen: ${end.kind}`);
      }

      // ── 3. Bygga ─────────────────────────────────────────────
      if (state.phase === "build") {
        if (state.buildRounds >= cfg.limits.buildRounds) {
          return block(ctx, `Alla ${cfg.limits.buildRounds} Bygga-varv är förbrukade utan att arbetet blev klart.`);
        }
        for (const repo of state.repos) {
          const m = await mergeDefault(join(dir, repo));
          if (m === "conflict") extra.push(`${repo}: merge av standardbranchen gav konflikter. Lös dem först.`);
          if (m === "merged") ui.info(`${repo}: standardbranchen inmergad.`);
        }
        state.buildRounds++;
        save();
        ui.heading(`Copilot bygger (varv ${state.buildRounds} av ${cfg.limits.buildRounds})…`);
        const plan = store.read("plan/approved.md") ?? "";
        const end = await runSession(
          agent,
          { model: cfg.models.main, researcherModel: cfg.models.researcher, cwd: dir, systemPrompt: BUILD_SYSTEM, policy: policyFor("build"), afterTool },
          buildTools(ctx),
          { prompt: buildPrompt(state, plan, extra.splice(0)), budget, idleMs: cfg.limits.idleTimeoutMin * 60_000, log },
        );
        const next = await handleCommon(end, ctx, budget);
        if (next === "retry") {
          state.buildRounds--;
          continue;
        }
        if (next !== undefined) return next;
        if (end.kind === "ready") {
          state.prs = end.prs;
          state.phase = "publish";
          save();
          continue;
        }
        if (end.kind === "no-change") {
          ui.heading("Ingen ändring behövs");
          ui.info(end.reason);
          state.phase = "done";
          save();
          return EXIT.done;
        }
        if (end.kind === "gave-up") {
          ui.warn(`${end.reason} Startar ett nytt varv.`);
          extra.push(`Förra varvet avbröts: ${end.reason}`);
          continue;
        }
        throw new Error(`Oväntat slut på Bygga: ${end.kind}`);
      }

      // ── 4–5. Publicera ───────────────────────────────────────
      if (state.phase === "publish") {
        for (const repo of state.repos) {
          const m = await mergeDefault(join(dir, repo));
          if (m === "conflict") extra.push(`${repo}: merge av standardbranchen gav konflikter. Lös dem och anropa ready_for_pr igen.`);
        }
        const problems = await checkReady(ctx, state.prs);
        if (problems.length) {
          ui.warn("Inte längre redo att publicera – tillbaka till Bygga.");
          extra.push(`Inför publicering hittades problem:\n${problems.map((p) => `- ${p}`).join("\n")}`);
          state.phase = "build";
          save();
          continue;
        }
        if (args.noPublish) {
          ui.info("Klart att publicera. Kör utan --no-publish för att publicera.");
          return EXIT.paused;
        }
        const mode = await askPublish(ctx, state.prs);
        if (!mode) return EXIT.paused;
        ui.heading("Publicerar…");
        await publish(ctx, state.prs, mode);
        state.phase = "done";
        save();
        return EXIT.done;
      }

      // ── Klart sedan tidigare ─────────────────────────────────
      if (state.phase === "done") {
        const drafts = Object.entries(state.publish).filter(([, p]) => p.prUrl && !p.ready);
        if (!drafts.length) {
          ui.info("Ärendet är klart. Kör wf clean när PR:erna är mergade.");
          return EXIT.done;
        }
        const r = await ui.select(`${drafts.length} PR:er är drafts. Markera dem som redo för granskning?`, [
          { value: "ready", label: "Ja, redo för granskning" },
          { value: "no", label: "Nej" },
        ]);
        if (r.kind === "ok" && r.value === "ready") await publish(ctx, state.prs, "ready");
        return EXIT.done;
      }
    }
  } finally {
    if (ctx) {
      state!.aic.total = round(state!.aic.total + budget.spentAic);
      store.save(state!);
      store.log("usage.log", { aic: round(budget.spentAic), total: state!.aic.total });
      ui.info(`\nAI-krediter: ${round(budget.spentAic)} denna körning, ${state!.aic.total} totalt för ärendet.`);
    }
    release();
  }
}

/** Utfall som hanteras likadant i alla faser. "retry" = kör samma fas igen. */
async function handleCommon(end: End, ctx: WfCtx, budget: Budget): Promise<ExitCode | "retry" | undefined> {
  const { ui } = ctx;
  switch (end.kind) {
    case "paused":
      ui.info(`\nPausad: ${end.reason}\nFortsätt med: wf run ${ctx.state.key}`);
      return EXIT.paused;
    case "hung":
      ui.warn("Copilot svarade inte på länge och stoppades. Kör wf run igen för att fortsätta.");
      return EXIT.paused;
    case "blocked":
      return block(ctx, end.reason);
    case "budget": {
      const r = await ui.select(`AI-kreditaket (${budget.limitAic}) är nått. Vad vill du göra?`, [
        { value: "raise", label: "Höj taket med 500 och fortsätt" },
        { value: "pause", label: "Pausa" },
      ]);
      if (r.kind === "ok" && r.value === "raise") {
        budget.limitAic += 500;
        return "retry";
      }
      return EXIT.paused;
    }
    default:
      return undefined;
  }
}

function block(ctx: WfCtx, reason: string): ExitCode {
  ctx.state.phase = "blocked";
  ctx.state.blockedReason = reason;
  ctx.save();
  ctx.ui.heading("Blockerat");
  ctx.ui.info(reason);
  ctx.ui.info(`När det är löst: wf run ${ctx.state.key} -m "vad som ändrats"`);
  return EXIT.blocked;
}

function currentPlan(store: Store, state: State) {
  return state.plan ? store.read(`plan/v${state.plan.version}.md`) : undefined;
}

const phaseName = (p: State["phase"]) =>
  ({ plan: "planering", build: "bygga", publish: "publicering", done: "klart", blocked: "blockerat" })[p];
const now = () => new Date().toISOString();
const round = (n: number) => Math.round(n * 100) / 100;
