import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, must, run } from "./exec.ts";
import type { PrInfo } from "./state.ts";
import type { CwfCtx } from "./tools.ts";
import type { Reply } from "./ui.ts";
import { defaultBranch, worktreeDir } from "./workspace.ts";

export type PublishMode = "draft" | "ready";

const START = "<!-- cwf:start -->";
const END = "<!-- cwf:end -->";
const MAX_BODY = 60_000;

/** PRs in dependency order: the ones others depend on come first. */
export function orderByDependencies(prs: PrInfo[]): PrInfo[] {
  const byRepo = new Map(prs.map((p) => [p.repo, p]));
  const out: PrInfo[] = [];
  const visiting = new Set<string>();
  const visit = (p: PrInfo) => {
    if (out.includes(p)) return;
    if (visiting.has(p.repo)) throw new Error(`Circular dependency between PRs (${p.repo}).`);
    visiting.add(p.repo);
    for (const d of p.dependsOn) {
      const dep = byRepo.get(d);
      if (dep) visit(dep);
    }
    visiting.delete(p.repo);
    out.push(p);
  };
  prs.forEach(visit);
  return out;
}

/** Builds cwf's part of the PR text. The rest of the text (what someone wrote by hand) is left untouched. */
export function mergeBody(existing: string | undefined, cwfPart: string): string {
  let part = `${START}\n${cwfPart}\n${END}`;
  if (part.length > MAX_BODY) part = `${START}\n${cwfPart.slice(0, MAX_BODY - 200)}\n\n…(truncated by cwf)\n${END}`;
  if (!existing) return part;
  const s = existing.indexOf(START);
  const e = existing.indexOf(END);
  if (s >= 0 && e > s) return existing.slice(0, s) + part + existing.slice(e + END.length);
  return `${part}\n\n${existing}`;
}

/** Summary shown before the publish decision. */
export async function summary(ctx: CwfCtx, prs: PrInfo[]): Promise<string> {
  const lines: string[] = [];
  for (const p of prs) {
    const wt = worktreeDir(ctx.cfg, ctx.slug, p.repo);
    const base = await defaultBranch(wt);
    const log = (await git(wt, "log", "--oneline", `origin/${base}..HEAD`)).trim();
    const stat = (await git(wt, "diff", "--shortstat", `origin/${base}...HEAD`)).trim();
    const deleted = (await git(wt, "diff", "--name-only", "--diff-filter=D", `origin/${base}...HEAD`))
      .split("\n")
      .filter((f) => /(test|spec)/i.test(f));
    lines.push(`\n■ ${p.repo}: ${p.title}`, `  ${stat}`, ...log.split("\n").map((l) => `    ${l}`));
    if (p.dependsOn.length) lines.push(`  Depends on: ${p.dependsOn.join(", ")}`);
    if (deleted.length) lines.push(`  ⚠ Deleted test files: ${deleted.join(", ")}`);
  }
  const decisions = (ctx.store.read("decisions.log") ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { decision: string; why?: string; deviatesFromPlan?: boolean; source?: string })
    .filter((d) => d.deviatesFromPlan);
  if (decisions.length) {
    lines.push("\nDeviations from the plan:");
    for (const d of decisions) lines.push(`  • ${d.decision} – ${d.why ?? ""}`);
  }
  return lines.join("\n");
}

/** The publish decision. Returns the chosen mode, or null for a pause. */
export async function askPublish(ctx: CwfCtx, prs: PrInfo[]): Promise<PublishMode | null> {
  const { ui, cfg } = ctx;
  ui.heading("Ready to publish");
  ui.info(await summary(ctx, prs));
  ui.info("\n✓ All checks are green.");
  const draft = { value: "draft" as const, label: "Draft PR" };
  const ready = { value: "ready" as const, label: "Ready for review" };
  const order = cfg.publish.default === "ready" ? [ready, draft] : [draft, ready];
  const r: Reply<"draft" | "ready" | "pause"> = await ui.select("How do you want to publish?", [
    ...order,
    { value: "pause", label: "Pause" },
  ]);
  if (r.kind === "timeout" || r.value === "pause") return null;
  return r.value;
}

interface GhPr {
  url: string;
  number: number;
  isDraft: boolean;
  body: string;
}

async function findPr(wt: string, branch: string): Promise<GhPr | undefined> {
  const out = await must("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url,number,isDraft,body"], { cwd: wt });
  return (JSON.parse(out) as GhPr[])[0];
}

/**
 * Pushes and creates/updates PRs step by step. Each step is saved, so a new run after an
 * interruption continues where it stopped, without duplicates.
 */
export async function publish(ctx: CwfCtx, prs: PrInfo[], mode: PublishMode): Promise<void> {
  const { state, cfg, ui } = ctx;
  const ordered = orderByDependencies(prs);
  const tmp = mkdtempSync(join(tmpdir(), "cwf-pr-"));
  try {
    for (const p of ordered) {
      const wt = worktreeDir(cfg, ctx.slug, p.repo);
      const step = (state.publish[p.repo] ??= { pushed: false, ready: false });

      // Push every time: new commits may have appeared. Never --force.
      const push = await run("git", ["push", "-u", "origin", `HEAD:refs/heads/${state.branch}`], { cwd: wt });
      if (push.code !== 0) {
        throw new Error(`Push of ${p.repo} was rejected: ${push.stderr.trim()}\nRun git merge origin/${state.branch} or check the branch protection rules.`);
      }
      step.pushed = true;
      ctx.save();

      const deps = p.dependsOn
        .map((d) => state.publish[d]?.prUrl)
        .filter(Boolean)
        .map((u) => `- ${u}`);
      const cwfPart = [
        p.body.trim(),
        "",
        `Jira: https://${cfg.jira.site.replace(/^https?:\/\//, "")}/browse/${state.key}`,
        ...(deps.length ? ["", "Merge after:", ...deps] : []),
      ].join("\n");

      const existing = await findPr(wt, state.branch);
      const bodyFile = join(tmp, `${p.repo}.md`);
      writeFileSync(bodyFile, mergeBody(existing?.body, cwfPart));
      let isDraft: boolean;
      if (existing) {
        await must("gh", ["pr", "edit", String(existing.number), "--title", p.title, "--body-file", bodyFile], { cwd: wt });
        step.prUrl = existing.url;
        isDraft = existing.isDraft;
      } else {
        const out = await must("gh", ["pr", "create", "--draft", "--head", state.branch, "--title", p.title, "--body-file", bodyFile], { cwd: wt });
        step.prUrl = out.trim().split("\n").pop();
        isDraft = true;
      }
      ctx.save();

      if (mode === "ready" && isDraft) {
        await must("gh", ["pr", "ready", step.prUrl!], { cwd: wt });
        for (const r of cfg.publish.reviewersOnReady) {
          await run("gh", ["pr", "edit", step.prUrl!, "--add-reviewer", r], { cwd: wt });
        }
      }
      step.ready = mode === "ready" || !isDraft;
      ctx.save();
      ui.info(`  ${p.repo}: ${step.prUrl}${step.ready ? "" : " (draft)"}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
