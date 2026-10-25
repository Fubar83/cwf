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
import { askQuestions, buildTools, checkReady, planTools, reviewPlan, type CwfCtx } from "./tools.ts";
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
  let ctx!: CwfCtx;
  const save = () => store.save(state);

  try {
    // ── 1. Prepare ────────────────────────────────────────────
    const fresh = !store.exists();
    let issue: Issue | undefined;
    try {
      issue = await getIssue(cfg, key);
    } catch (e) {
      if (fresh) throw e;
      ui.warn(`Could not fetch the issue (${(e as Error).message}). Continuing with the saved copy.`);
    }

    if (fresh) {
      const repos = args.repos.length ? args.repos : project.repos;
      state = {
        schema: 1, key, repos, branch: branchName(slug, issue!.summary), phase: "plan",
        issueHash: issue!.hash, notes: [], pendingQuestions: [], answers: [], buildRounds: 0,
        prs: [], publish: {}, aic: { total: 0 },
      };
      ui.heading(`${key}: ${issue!.summary}`);
      ui.info(`Repos: ${repos.join(", ")} · branch ${state.branch}`);
    } else {
      state = store.load();
      ui.heading(`${key} – continuing (${phaseName(state.phase)})`);
      if (args.repos.length && args.repos.join() !== state.repos.join()) {
        ui.warn(`The issue already uses ${state.repos.join(", ")}. The repos given are ignored.`);
      }
    }
    ctx = { cfg, ui, store, state, slug, save };

    if (issue) {
      store.write("issue.json", JSON.stringify(issue.raw, null, 2) + "\n");
      if (!fresh && issue.hash !== state.issueHash && state.phase !== "done") {
        const r = await ui.select("The issue has changed in Jira since the last run. What do you want to do?", [
          { value: "replan", label: "Redo the plan based on the new issue" },
          { value: "continue", label: "Continue as planned" },
          { value: "pause", label: "Pause" },
        ]);
        if (r.kind === "timeout" || r.value === "pause") return EXIT.paused;
        if (r.value === "replan") {
          state.phase = "plan";
          state.plan = undefined;
          state.notes.push({ at: now(), text: "The issue has changed in Jira. Read it again and make a new plan." });
        }
      }
      state.issueHash = issue.hash;
    }

    if (args.note) state.notes.push({ at: now(), text: args.note });

    if (state.phase === "blocked") {
      if (!args.note) {
        ui.warn(`Blocked: ${state.blockedReason}`);
        ui.info(`Resolve it and run again with a note: cwf run ${key} -m "..."`);
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

    // ── Unanswered questions from last time ──────────────────
    if (state.pendingQuestions.length) {
      ui.info(`You have ${state.pendingQuestions.length} unanswered questions from last time.`);
      if ((await askQuestions(ctx, [...state.pendingQuestions])) === "paused") return EXIT.paused;
    }

    const policyFor = (phase: "plan" | "build") => makePolicy({ phase, issueDir: dir });
    const log = (entry: Record<string, unknown>) => store.log("logs/session.log", entry);
    const extra: string[] = [];

    for (;;) {
      // ── 2. Understand and plan ───────────────────────────────
      if (state.phase === "plan") {
        // A plan waiting for review is shown directly, without a new session.
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
        ui.heading(state.plan?.feedback.length ? "Copilot is revising the plan…" : "Copilot is reading the issue and drafting a plan…");
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
        throw new Error(`Unexpected end of the plan phase: ${end.kind}`);
      }

      // ── 3. Build ─────────────────────────────────────────────
      if (state.phase === "build") {
        if (state.buildRounds >= cfg.limits.buildRounds) {
          return block(ctx, `All ${cfg.limits.buildRounds} build rounds are used up without the work being done.`);
        }
        for (const repo of state.repos) {
          const m = await mergeDefault(join(dir, repo));
          if (m === "conflict") extra.push(`${repo}: merging the default branch gave conflicts. Resolve them first.`);
          if (m === "merged") ui.info(`${repo}: default branch merged in.`);
        }
        state.buildRounds++;
        save();
        ui.heading(`Copilot is building (round ${state.buildRounds} of ${cfg.limits.buildRounds})…`);
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
          ui.heading("No change needed");
          ui.info(end.reason);
          state.phase = "done";
          save();
          return EXIT.done;
        }
        if (end.kind === "gave-up") {
          ui.warn(`${end.reason} Starting a new round.`);
          extra.push(`The previous round was aborted: ${end.reason}`);
          continue;
        }
        throw new Error(`Unexpected end of the build phase: ${end.kind}`);
      }

      // ── 4–5. Publish ─────────────────────────────────────────
      if (state.phase === "publish") {
        for (const repo of state.repos) {
          const m = await mergeDefault(join(dir, repo));
          if (m === "conflict") extra.push(`${repo}: merging the default branch gave conflicts. Resolve them and call ready_for_pr again.`);
        }
        const problems = await checkReady(ctx, state.prs);
        if (problems.length) {
          ui.warn("No longer ready to publish – back to build.");
          extra.push(`Problems found before publishing:\n${problems.map((p) => `- ${p}`).join("\n")}`);
          state.phase = "build";
          save();
          continue;
        }
        if (args.noPublish) {
          ui.info("Ready to publish. Run without --no-publish to publish.");
          return EXIT.paused;
        }
        const mode = await askPublish(ctx, state.prs);
        if (!mode) return EXIT.paused;
        ui.heading("Publishing…");
        await publish(ctx, state.prs, mode);
        state.phase = "done";
        save();
        return EXIT.done;
      }

      // ── Already done earlier ─────────────────────────────────
      if (state.phase === "done") {
        const drafts = Object.entries(state.publish).filter(([, p]) => p.prUrl && !p.ready);
        if (!drafts.length) {
          ui.info("The issue is done. Run cwf clean when the PRs are merged.");
          return EXIT.done;
        }
        const r = await ui.select(`${drafts.length} PRs are drafts. Mark them as ready for review?`, [
          { value: "ready", label: "Yes, ready for review" },
          { value: "no", label: "No" },
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
      ui.info(`\nAI credits: ${round(budget.spentAic)} this run, ${state!.aic.total} total for the issue.`);
    }
    release();
  }
}

/** Outcomes handled the same way in every phase. "retry" = run the same phase again. */
async function handleCommon(end: End, ctx: CwfCtx, budget: Budget): Promise<ExitCode | "retry" | undefined> {
  const { ui } = ctx;
  switch (end.kind) {
    case "paused":
      ui.info(`\nPaused: ${end.reason}\nContinue with: cwf run ${ctx.state.key}`);
      return EXIT.paused;
    case "hung":
      ui.warn("Copilot did not respond for too long and was stopped. Run cwf run again to continue.");
      return EXIT.paused;
    case "blocked":
      return block(ctx, end.reason);
    case "budget": {
      const r = await ui.select(`The AI-credit cap (${budget.limitAic}) has been reached. What do you want to do?`, [
        { value: "raise", label: "Raise the cap by 500 and continue" },
        { value: "pause", label: "Pause" },
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

function block(ctx: CwfCtx, reason: string): ExitCode {
  ctx.state.phase = "blocked";
  ctx.state.blockedReason = reason;
  ctx.save();
  ctx.ui.heading("Blocked");
  ctx.ui.info(reason);
  ctx.ui.info(`When it is resolved: cwf run ${ctx.state.key} -m "what changed"`);
  return EXIT.blocked;
}

function currentPlan(store: Store, state: State) {
  return state.plan ? store.read(`plan/v${state.plan.version}.md`) : undefined;
}

const phaseName = (p: State["phase"]) =>
  ({ plan: "planning", build: "building", publish: "publishing", done: "done", blocked: "blocked" })[p];
const now = () => new Date().toISOString();
const round = (n: number) => Math.round(n * 100) / 100;
