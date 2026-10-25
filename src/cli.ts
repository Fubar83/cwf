import { parseArgs } from "node:util";
import { CopilotAgent } from "./agent/copilot.ts";
import { clean } from "./clean.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { CommandError } from "./exec.ts";
import { EXIT, runIssue } from "./loop.ts";
import { preflight } from "./preflight.ts";
import { LockedError } from "./state.ts";
import { TerminalUI } from "./ui.ts";

const HELP = `cwf – takes a Jira issue to a pull request with GitHub Copilot

Usage:
  cwf run <KEY> [repos…] [flags]   Start or continue an issue
  cwf clean                        Remove finished issues

Flags for run:
  -m, --note <text>     Note for Copilot (required to continue a blocked issue)
      --no-publish      Stop before publishing
      --aic-limit <n>   AI-credit cap for this run

Exit codes: 0 done · 10 paused · 20 blocked · 1 error
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      note: { type: "string", short: "m" },
      "no-publish": { type: "boolean", default: false },
      "aic-limit": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }

  const cfg = loadConfig();
  const ui = new TerminalUI(cfg.limits.waitForUserMin * 60_000);

  if (cmd === "clean") return clean(cfg, ui);

  if (cmd !== "run") {
    console.log(HELP);
    return 1;
  }
  const [key, ...repos] = rest;
  if (!key) {
    console.error("Give a Jira key, e.g. cwf run VFS-1350.");
    return 1;
  }

  const checks = await preflight(cfg);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    ui.heading("Preflight failed");
    for (const c of failed) ui.info(`  ✗ ${c.name}${c.detail ? ` – ${c.detail}` : ""}`);
    return EXIT.error;
  }

  const aicLimit = values["aic-limit"] ? Number(values["aic-limit"]) : undefined;
  if (aicLimit !== undefined && !(aicLimit >= 30)) {
    console.error("--aic-limit must be at least 30.");
    return 1;
  }

  const agent = new CopilotAgent();
  const stop = () => {
    void agent.stop().finally(() => process.exit(EXIT.paused));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    return await runIssue(
      { key, repos, note: values.note, noPublish: values["no-publish"], aicLimit },
      { cfg, ui, agent },
    );
  } finally {
    await agent.stop();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof ConfigError || e instanceof LockedError) console.error(e.message);
    else if (e instanceof CommandError) console.error(`Error: ${e.message}`);
    else console.error(e?.stack ?? e);
    process.exit(EXIT.error);
  },
);
