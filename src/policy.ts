import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PolicyDecision, ToolCall } from "./agent/types.ts";

export type PolicyPhase = "plan" | "build";

export interface PolicyContext {
  phase: PolicyPhase;
  /** Ärendekatalogen, t.ex. projects/vfs-1350. Worktrees ligger direkt under den. */
  issueDir: string;
}

const allow: PolicyDecision = { allow: true };
const deny = (reason: string): PolicyDecision => ({ allow: false, reason });

/** Kommandon som alltid nekas, oavsett fas. Matchas mot varje delkommando. */
const ALWAYS_DENY: [RegExp, string][] = [
  [/^git\s+push\b/, "Push gör wf efter ditt godkännande vid publicering."],
  [/^git\s+(rebase|reset\s+--hard|checkout|switch|clean|stash|filter-branch|worktree)\b/, "wf använder bara merge och ändrar aldrig vilken branch som är utcheckad. Använd git restore för att ångra filer."],
  [/^git\s+commit\b.*(--no-verify|\s-n\b)/, "Hooks får inte hoppas över."],
  [/^git\s+(config|remote)\b/, "Git-inställningar och remotes ändras inte."],
  [/^gh\s+(pr\s+(create|merge|ready|close|edit|comment|review)|repo\s+(delete|edit|create)|release|secret|variable|workflow\s+run)\b/, "Skrivande gh-kommandon sköts av wf."],
  [/^gh\s+api\b/, "gh api är inte tillåtet. Använd gh search, gh repo view eller gh pr view."],
  [/^(cdk|npx\s+cdk|npx\s+aws-cdk)\s+(deploy|destroy|bootstrap|import|watch)\b/, "Inga ändringar i AWS. Använd cdk synth."],
  [/^(aws|curl|wget|ssh|scp|nc|ncat|telnet)\b/, "Nätverks- och molnkommandon är inte tillåtna."],
  [/^(sudo|su|chmod\s+-R\s+777|rm\s+-rf\s+\/)(\s|$)/, "Inte tillåtet."],
];

/** Läsande twg-kommandon. Allt annat i twg nekas. */
const TWG_READ = /^twg\s+(context\s|confluence\s+(pages|page)\s+(get|view)\b|jira\s+workitem\s+(get|view|query)\b|help\b|--version|doctor\b)/;

/** Det enda som får köras i planläget. */
const PLAN_READ_ONLY = [
  /^(ls|cat|head|tail|wc|rg|grep|find|tree|file|stat|pwd|echo|sort|uniq|jq|diff)(\s|$)/,
  /^git\s+(log|show|diff|status|grep|ls-files|ls-tree|blame|branch|rev-parse|merge-base|cat-file)\b/,
  /^gh\s+(search\s+code|repo\s+view|pr\s+(view|list|diff|checks)|issue\s+view)\b/,
  /^dotnet\s+(--info|--version|list)\b/,
  /^(npm|pnpm|yarn)\s+(ls|list|view|why)\b/,
];

/** Delar upp en kommandorad i delkommandon (;, &&, ||, |, nyrad). */
export function splitCommand(cmd: string): string[] {
  return cmd
    .split(/\s*(?:;|&&|\|\||\||\n)\s*/)
    .map((s) => s.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")) // FOO=bar cmd
    .filter(Boolean);
}

function commandOf(args: Record<string, unknown>): string | undefined {
  for (const k of ["command", "cmd", "script", "fullCommandText", "input"]) {
    if (typeof args[k] === "string") return args[k] as string;
  }
  return undefined;
}

function pathsOf(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ["path", "file_path", "filePath", "fileName", "filename", "target", "file"]) {
    if (typeof args[k] === "string") out.push(args[k] as string);
  }
  if (Array.isArray(args.possiblePaths)) out.push(...args.possiblePaths.filter((p): p is string => typeof p === "string"));
  return out;
}

type Kind = "shell" | "write" | "read" | "url" | "mcp-write" | "other";

function classify(call: ToolCall): Kind {
  const k = call.kind;
  const n = call.toolName.toLowerCase();
  if (/github|mcp/.test(n) && /(create|update|delete|merge|push|write|add_|remove|fork|close|assign)/.test(n)) return "mcp-write";
  if (k === "shell" || /^(bash|shell|powershell|terminal|run_command|exec)/.test(n)) return "shell";
  if (k === "write" || /(edit|create|write|str_replace|apply_patch|insert|delete_file|rename|move)/.test(n)) return "write";
  if (k === "url" || /(fetch|url|web|browse)/.test(n)) return "url";
  if (k === "read" || /(view|read|glob|grep|search|list|ls)/.test(n)) return "read";
  return "other";
}

const SECRET_PATHS = [/(^|[\/\s'"=])\.env(\.|\s|$|['"])/, /\/\.config\/gh(\/|$)/, /\/\.config\/twg(\/|$)/, /\/\.aws(\/|$)/, /\/\.ssh(\/|$)/, /\/\.copilot\/.*token/i];

function inside(parent: string, p: string) {
  const rel = relative(parent, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Kontrollerar ett enskilt delkommando i skalet. */
function checkCommand(sub: string, ctx: PolicyContext): PolicyDecision {
  if (/^twg\s+/.test(sub)) {
    return TWG_READ.test(sub) ? allow : deny("Bara läsande twg-kommandon är tillåtna (context, confluence pages get, jira workitem get/query).");
  }
  for (const [re, reason] of ALWAYS_DENY) {
    if (re.test(sub)) return deny(reason);
  }
  if (/(^|\s)(\.wf\/|\.wf$)/.test(sub) && !/^(cat|head|tail|ls|rg|grep)\b/.test(sub)) {
    return deny(".wf/ ägs av wf och får inte ändras.");
  }
  if (SECRET_PATHS.some((re) => re.test(sub))) return deny("Hemligheter och inloggningsfiler får inte läsas.");
  if (ctx.phase === "plan") {
    if (/[^>]>{1,2}|^>/.test(` ${sub}`.replace(/2>&1|>\s*\/dev\/null/g, ""))) {
      return deny("Planläget är skrivskyddat: omdirigering till fil är inte tillåten.");
    }
    if (!PLAN_READ_ONLY.some((re) => re.test(sub))) {
      return deny(`Planläget är skrivskyddat. "${sub.split(/\s+/).slice(0, 2).join(" ")}" är inte ett läsande kommando. Ändringar görs i Bygga efter godkänd plan.`);
    }
  }
  return allow;
}

/** Policyn för inbyggda verktyg. Används både i onPreToolUse och onPermissionRequest. */
export function makePolicy(ctx: PolicyContext) {
  const root = resolve(ctx.issueDir);
  const wfDir = resolve(root, ".wf");
  const home = homedir();

  return (call: ToolCall): PolicyDecision => {
    const kind = classify(call);
    if (kind === "mcp-write") return deny("Skrivande GitHub-verktyg är avstängda. wf sköter PR:er.");
    if (kind === "url") return deny("Webbåtkomst är avstängd. Läs bara det som är länkat i ärendet via twg.");

    if (kind === "shell") {
      const cmd = commandOf(call.args);
      if (!cmd) return deny("Kunde inte läsa kommandot.");
      if (/`|\$\(/.test(cmd)) return deny("Kommandosubstitution (` eller $( ) är inte tillåten. Kör kommandona var för sig.");
      for (const sub of splitCommand(cmd)) {
        const d = checkCommand(sub, ctx);
        if (!d.allow) return d;
      }
      return allow;
    }

    const paths = pathsOf(call.args).map((p) => resolve(root, p.replace(/^~(?=\/)/, home)));
    for (const p of paths) {
      if (SECRET_PATHS.some((re) => re.test(p))) return deny("Hemligheter och inloggningsfiler får inte läsas.");
    }

    if (kind === "write") {
      if (ctx.phase === "plan") return deny("Planläget är skrivskyddat. Skicka planen med submit_plan.");
      if (paths.length === 0) return deny("Kunde inte avgöra vilken fil som ska skrivas.");
      for (const p of paths) {
        if (inside(wfDir, p)) return deny(".wf/ ägs av wf och får inte ändras.");
        if (!inside(root, p) || p === root) return deny(`Skrivning är bara tillåten i ärendets worktrees under ${root}${sep}.`);
      }
    }
    return allow;
  };
}

/** Varningar efter en filändring, som läggs till Copilots kontext. */
export function afterTool(call: ToolCall): string | undefined {
  const content = ["content", "new_str", "newText", "file_text", "patch"]
    .map((k) => call.args[k])
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  if (!content) return undefined;
  const hits: string[] = [];
  if (/@ts-ignore|@ts-nocheck|eslint-disable/.test(content)) hits.push("undantag från typ- eller lintkontroll");
  if (/NagSuppressions|addResourceSuppressions/.test(content)) hits.push("cdk-nag-undantag");
  if (/\[(Fact|Test|TestMethod)\(Skip|\.skip\(|xit\(|xdescribe\(/.test(content)) hits.push("överhoppade tester");
  if (/#pragma warning disable|SuppressMessage/.test(content)) hits.push("undertryckta varningar");
  return hits.length
    ? `wf: ändringen innehåller ${hits.join(", ")}. Gör det bara om det verkligen behövs, och motivera med record_decision.`
    : undefined;
}
