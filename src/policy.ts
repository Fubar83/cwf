import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PolicyDecision, ToolCall } from "./agent/types.ts";

export type PolicyPhase = "plan" | "build";

export interface PolicyContext {
  phase: PolicyPhase;
  /** The issue directory, e.g. projects/vfs-1350. Worktrees are directly under it. */
  issueDir: string;
}

const allow: PolicyDecision = { allow: true };
const deny = (reason: string): PolicyDecision => ({ allow: false, reason });

/** Commands that are always denied, in every phase. Matched against each sub-command. */
const ALWAYS_DENY: [RegExp, string][] = [
  [/^git\s+push\b/, "Pushing is done by cwf after your approval at publish time."],
  [/^git\s+(rebase|reset\s+--hard|checkout|switch|clean|stash|filter-branch|worktree)\b/, "cwf only merges and never changes the checked-out branch. Use git restore to undo files."],
  [/^git\s+commit\b.*(--no-verify|\s-n\b)/, "Hooks must not be skipped."],
  [/^git\s+(config|remote)\b/, "Git configuration and remotes are not changed."],
  [/^gh\s+(pr\s+(create|merge|ready|close|edit|comment|review)|repo\s+(delete|edit|create)|release|secret|variable|workflow\s+run)\b/, "Writing gh commands are run by cwf."],
  [/^gh\s+api\b/, "gh api is not allowed. Use gh search, gh repo view or gh pr view."],
  [/^(aws|curl|wget|ssh|scp|nc|ncat|telnet)\b/, "Network and cloud commands are not allowed."],
  [/^(sudo|su|chmod\s+-R\s+777|rm\s+-rf\s+\/)(\s|$)/, "Not allowed."],
];

/** Read-only twg commands. Every other twg command is denied. */
const TWG_READ = /^twg\s+(context\s|confluence\s+(pages|page)\s+(get|view)\b|jira\s+workitem\s+(get|view|query)\b|help\b|--version|doctor\b)/;

/** The only commands allowed in the plan phase. */
const PLAN_READ_ONLY = [
  /^(ls|cat|head|tail|wc|rg|grep|find|tree|file|stat|pwd|echo|sort|uniq|jq|diff)(\s|$)/,
  /^git\s+(log|show|diff|status|grep|ls-files|ls-tree|blame|branch|rev-parse|merge-base|cat-file)\b/,
  /^gh\s+(search\s+code|repo\s+view|pr\s+(view|list|diff|checks)|issue\s+view)\b/,
  /^dotnet\s+(--info|--version|list)\b/,
  /^(npm|pnpm|yarn)\s+(ls|list|view|why)\b/,
];

/** Splits a command line into sub-commands (;, &&, ||, |, newline). */
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

/** Checks a single sub-command of a shell line. */
function checkCommand(sub: string, ctx: PolicyContext): PolicyDecision {
  if (/^twg\s+/.test(sub)) {
    return TWG_READ.test(sub) ? allow : deny("Only read-only twg commands are allowed (context, confluence pages get, jira workitem get/query).");
  }
  for (const [re, reason] of ALWAYS_DENY) {
    if (re.test(sub)) return deny(reason);
  }
  if (/(^|\s)(\.cwf\/|\.cwf$)/.test(sub) && !/^(cat|head|tail|ls|rg|grep)\b/.test(sub)) {
    return deny(".cwf/ is owned by cwf and must not be changed.");
  }
  if (SECRET_PATHS.some((re) => re.test(sub))) return deny("Secrets and login files must not be read.");
  if (ctx.phase === "plan") {
    if (/[^>]>{1,2}|^>/.test(` ${sub}`.replace(/2>&1|>\s*\/dev\/null/g, ""))) {
      return deny("The plan phase is read-only: redirecting output to a file is not allowed.");
    }
    if (!PLAN_READ_ONLY.some((re) => re.test(sub))) {
      return deny(`The plan phase is read-only. "${sub.split(/\s+/).slice(0, 2).join(" ")}" is not a read-only command. Changes are made in the build phase after the plan is approved.`);
    }
  }
  return allow;
}

/** The policy for built-in tools. Used by both onPreToolUse and onPermissionRequest. */
export function makePolicy(ctx: PolicyContext) {
  const root = resolve(ctx.issueDir);
  const cwfDir = resolve(root, ".cwf");
  const home = homedir();

  return (call: ToolCall): PolicyDecision => {
    const kind = classify(call);
    if (kind === "mcp-write") return deny("Writing GitHub tools are disabled. cwf handles the PRs.");
    if (kind === "url") return deny("Web access is disabled. Only read what the issue links to, via twg.");

    if (kind === "shell") {
      const cmd = commandOf(call.args);
      if (!cmd) return deny("Could not read the command.");
      if (/`|\$\(/.test(cmd)) return deny("Command substitution (` or $( ) is not allowed. Run the commands one at a time.");
      for (const sub of splitCommand(cmd)) {
        const d = checkCommand(sub, ctx);
        if (!d.allow) return d;
      }
      return allow;
    }

    const paths = pathsOf(call.args).map((p) => resolve(root, p.replace(/^~(?=\/)/, home)));
    for (const p of paths) {
      // Normalize separators first, so the POSIX patterns also match Windows paths.
      if (SECRET_PATHS.some((re) => re.test(p.split(sep).join("/")))) return deny("Secrets and login files must not be read.");
    }

    if (kind === "write") {
      if (ctx.phase === "plan") return deny("The plan phase is read-only. Submit the plan with submit_plan.");
      if (paths.length === 0) return deny("Could not tell which file is to be written.");
      for (const p of paths) {
        if (inside(cwfDir, p)) return deny(".cwf/ is owned by cwf and must not be changed.");
        if (!inside(root, p) || p === root) return deny(`Writing is only allowed in the issue's worktrees under ${root}${sep}.`);
      }
    }
    return allow;
  };
}

/** Warnings after a file change, added to Copilot's context. */
export function afterTool(call: ToolCall): string | undefined {
  const content = ["content", "new_str", "newText", "file_text", "patch"]
    .map((k) => call.args[k])
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  if (!content) return undefined;
  const hits: string[] = [];
  if (/@ts-ignore|@ts-nocheck|eslint-disable/.test(content)) hits.push("type- or lint-check exemptions");
  if (/\[(Fact|Test|TestMethod)\(Skip|\.skip\(|xit\(|xdescribe\(/.test(content)) hits.push("skipped tests");
  if (/#pragma warning disable|SuppressMessage/.test(content)) hits.push("suppressed warnings");
  return hits.length
    ? `cwf: this change contains ${hits.join(", ")}. Only do this if it is really needed, and justify it with record_decision.`
    : undefined;
}
