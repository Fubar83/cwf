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

/** PR:er i beroendeordning: de som andra beror på kommer först. */
export function orderByDependencies(prs: PrInfo[]): PrInfo[] {
  const byRepo = new Map(prs.map((p) => [p.repo, p]));
  const out: PrInfo[] = [];
  const visiting = new Set<string>();
  const visit = (p: PrInfo) => {
    if (out.includes(p)) return;
    if (visiting.has(p.repo)) throw new Error(`Cirkulärt beroende mellan PR:er (${p.repo}).`);
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

/** Bygger cwf:s del av PR-texten. Resten av texten (det någon skrivit för hand) lämnas orörd. */
export function mergeBody(existing: string | undefined, cwfPart: string): string {
  let part = `${START}\n${cwfPart}\n${END}`;
  if (part.length > MAX_BODY) part = `${START}\n${cwfPart.slice(0, MAX_BODY - 200)}\n\n…(kortad av cwf)\n${END}`;
  if (!existing) return part;
  const s = existing.indexOf(START);
  const e = existing.indexOf(END);
  if (s >= 0 && e > s) return existing.slice(0, s) + part + existing.slice(e + END.length);
  return `${part}\n\n${existing}`;
}

/** Sammanfattning inför publiceringsbeslutet (K2). */
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
    if (p.dependsOn.length) lines.push(`  Beror på: ${p.dependsOn.join(", ")}`);
    if (deleted.length) lines.push(`  ⚠ Borttagna testfiler: ${deleted.join(", ")}`);
  }
  const decisions = (ctx.store.read("decisions.log") ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { decision: string; why?: string; deviatesFromPlan?: boolean; source?: string })
    .filter((d) => d.deviatesFromPlan);
  if (decisions.length) {
    lines.push("\nAvvikelser från planen:");
    for (const d of decisions) lines.push(`  • ${d.decision} – ${d.why ?? ""}`);
  }
  return lines.join("\n");
}

/** Publiceringsbeslutet. Returnerar valt läge eller null för paus. */
export async function askPublish(ctx: CwfCtx, prs: PrInfo[]): Promise<PublishMode | null> {
  const { ui, cfg } = ctx;
  ui.heading("Redo att publicera");
  ui.info(await summary(ctx, prs));
  ui.info("\n✓ Alla kontroller är gröna.");
  const draft = { value: "draft" as const, label: "Draft-PR" };
  const ready = { value: "ready" as const, label: "Redo för granskning" };
  const order = cfg.publish.default === "ready" ? [ready, draft] : [draft, ready];
  const r: Reply<"draft" | "ready" | "pause"> = await ui.select("Hur vill du publicera?", [
    ...order,
    { value: "pause", label: "Pausa" },
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
 * Pushar och skapar/uppdaterar PR:er stegvis. Varje steg sparas, så att en ny
 * körning efter ett avbrott fortsätter där den slutade utan dubbletter.
 */
export async function publish(ctx: CwfCtx, prs: PrInfo[], mode: PublishMode): Promise<void> {
  const { state, cfg, ui } = ctx;
  const ordered = orderByDependencies(prs);
  const tmp = mkdtempSync(join(tmpdir(), "cwf-pr-"));
  try {
    for (const p of ordered) {
      const wt = worktreeDir(cfg, ctx.slug, p.repo);
      const step = (state.publish[p.repo] ??= { pushed: false, ready: false });

      // Push varje gång: nya commits kan ha tillkommit. Aldrig --force.
      const push = await run("git", ["push", "-u", "origin", `HEAD:refs/heads/${state.branch}`], { cwd: wt });
      if (push.code !== 0) {
        throw new Error(`Push av ${p.repo} avvisades: ${push.stderr.trim()}\nKör git merge origin/${state.branch} eller kontrollera skyddsregler.`);
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
        ...(deps.length ? ["", "Mergas efter:", ...deps] : []),
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
