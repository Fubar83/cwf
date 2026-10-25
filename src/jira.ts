import { createHash } from "node:crypto";
import type { Config } from "./config.ts";
import { must } from "./exec.ts";

export interface Issue {
  key: string;
  summary: string;
  /** The whole twg response, saved as context for Copilot. */
  raw: unknown;
  /** Hash of description and acceptance criteria, to detect changes during a pause. */
  hash: string;
}

/** Picks a field out of the twg response, whether it is flat or nested under fields. */
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
 * Fetches the issue with its linked content via twg. Copilot then only reads the
 * Confluence pages linked from here (or in the description).
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
