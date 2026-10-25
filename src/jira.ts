import { createHash } from "node:crypto";
import type { Config } from "./config.ts";
import { must } from "./exec.ts";

export interface Issue {
  key: string;
  summary: string;
  /** Hela svaret från twg, sparas som context för Copilot. */
  raw: unknown;
  /** Hash av beskrivning och acceptanskriterier, för att upptäcka ändringar under paus. */
  hash: string;
}

/** Plockar ut ett fält ur twg-svaret oavsett om det ligger platt eller under fields. */
function pick(obj: unknown, ...names: string[]): unknown {
  const seen = new Set<unknown>();
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    for (const [k, v] of Object.entries(cur)) {
      if (names.includes(k) && v != null) return v;
      if (typeof v === "object") stack.push(v);
    }
  }
  return undefined;
}

export function parseIssue(key: string, raw: unknown): Issue {
  const data = (raw as { data?: unknown })?.data ?? raw;
  const summary = String(pick(data, "summary", "title") ?? key);
  const description = JSON.stringify(pick(data, "description") ?? "");
  const ac = JSON.stringify(pick(data, "acceptanceCriteria", "acceptance_criteria") ?? "");
  const hash = createHash("sha256").update(description).update(ac).update(summary).digest("hex").slice(0, 16);
  return { key, summary, raw: data, hash };
}

/**
 * Hämtar ärendet med länkat innehåll via twg. Copilot läser sedan bara de
 * Confluence-sidor som är länkade härifrån (eller i beskrivningen).
 */
export async function fetchIssue(cfg: Config, key: string): Promise<Issue> {
  const out = await must("twg", [
    "context", "jira", "workitem", key,
    "-s", cfg.jira.site,
    "-o", "json",
    "--mode", "agent",
  ], { timeoutMs: 120_000 });
  return parseIssue(key, JSON.parse(out));
}
