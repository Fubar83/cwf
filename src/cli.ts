import { parseArgs } from "node:util";
import { CopilotAgent } from "./agent/copilot.ts";
import { clean } from "./clean.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { CommandError } from "./exec.ts";
import { EXIT, runIssue } from "./loop.ts";
import { preflight } from "./preflight.ts";
import { LockedError } from "./state.ts";
import { TerminalUI } from "./ui.ts";

const HELP = `wf – tar ett Jira-ärende till en PR med GitHub Copilot

Användning:
  wf run <NYCKEL> [repon…] [flaggor]   Starta eller fortsätt ett ärende
  wf clean                             Städa bort klara ärenden

Flaggor för run:
  -m, --note <text>     Anteckning till Copilot (krävs för att fortsätta ett blockerat ärende)
      --no-publish      Stanna före publicering
      --aic-limit <n>   AI-kreditak för den här körningen
      --allow-host      Tillåt körning utanför devcontainer

Exitkoder: 0 klart · 10 pausad · 20 blockerad · 1 fel
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      note: { type: "string", short: "m" },
      "no-publish": { type: "boolean", default: false },
      "aic-limit": { type: "string" },
      "allow-host": { type: "boolean", default: false },
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
    console.error("Ange en Jira-nyckel, t.ex. wf run VFS-1350.");
    return 1;
  }

  const checks = await preflight(cfg, { allowHost: values["allow-host"] });
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    ui.heading("Förkontrollen misslyckades");
    for (const c of failed) ui.info(`  ✗ ${c.name}${c.detail ? ` – ${c.detail}` : ""}`);
    return EXIT.error;
  }

  const aicLimit = values["aic-limit"] ? Number(values["aic-limit"]) : undefined;
  if (aicLimit !== undefined && !(aicLimit >= 30)) {
    console.error("--aic-limit måste vara minst 30.");
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
    else if (e instanceof CommandError) console.error(`Fel: ${e.message}`);
    else console.error(e?.stack ?? e);
    process.exit(EXIT.error);
  },
);
