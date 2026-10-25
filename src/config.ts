import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

const GateStep = z.object({
  name: z.string(),
  run: z.string(),
  /** The step only runs if this file exists in the repo (relative path). */
  when: z.string().optional(),
  /** Command Copilot gets as a suggestion when the step fails. cwf never runs it itself. */
  fix: z.string().optional(),
});
export type GateStep = z.infer<typeof GateStep>;

const RepoRules = z.object({
  setup: z.array(z.string()).default([]),
  gate: z.array(GateStep).default([]),
});
export type RepoRules = z.infer<typeof RepoRules>;

export const ConfigSchema = z.object({
  projectsDir: z.string(),
  jira: z.object({
    site: z.string(),
    projects: z
      .array(
        z.object({
          key: z.string().transform((s) => s.toUpperCase()),
          repos: z.array(z.string()).min(1),
        }),
      )
      .min(1),
  }),
  github: z.object({ org: z.string() }),
  models: z
    .object({
      main: z.string().default("gpt-6.1-sol"),
      researcher: z.string().default("gpt-6-luna"),
      /**
       * USD per million tokens, for the live estimate of AIC (1 AIC = 0.01 USD).
       * The session total from the SDK replaces the estimate when it is available.
       */
      prices: z
        .record(z.string(), z.object({ input: z.number(), output: z.number() }))
        .default({
          "gpt-6.1-sol": { input: 2, output: 10 },
        }),
    })
    .prefault({}),
  limits: z
    .object({
      /** Soft AIC cap per run. cwf asks about raising it when it is reached. */
      aicPerRun: z.number().int().min(30).default(1000),
      buildRounds: z.number().int().min(1).default(4),
      /** Minutes without events before a session counts as hung. */
      idleTimeoutMin: z.number().min(1).default(10),
      /** Maximum time a cwf dialog may stay open before cwf pauses. */
      waitForUserMin: z.number().min(1).default(20),
    })
    .prefault({}),
  publish: z
    .object({
      default: z.enum(["draft", "ready"]).default("draft"),
      reviewersOnReady: z.array(z.string()).default([]),
    })
    .prefault({}),
  clean: z.object({ staleDays: z.number().int().default(14) }).prefault({}),
  repos: z
    .object({ defaults: RepoRules.prefault({}) })
    .catchall(RepoRules)
    .prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return process.env.CWF_CONFIG ?? join(base, "cwf", "config.yaml");
}

export class ConfigError extends Error {}

export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) {
    throw new ConfigError(
      `No config file at ${path}. Copy cwf.config.example.yaml there and fill it in.`,
    );
  }
  const raw = parseYaml(readFileSync(path, "utf8"));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`Error in ${path}:\n${lines.join("\n")}`);
  }
  const cfg = parsed.data;
  cfg.projectsDir = resolve(cfg.projectsDir.replace(/^~(?=$|\/)/, homedir()));
  return cfg;
}

/** Rules for a repo: repo-specific values replace the defaults field by field. */
export function rulesFor(cfg: Config, repo: string): RepoRules {
  const d = cfg.repos.defaults;
  const r = (cfg.repos as Record<string, RepoRules | undefined>)[repo];
  return {
    setup: r?.setup.length ? r.setup : d.setup,
    gate: r?.gate.length ? r.gate : d.gate,
  };
}

/** Normalizes the key and finds the Jira project. "vfs-1350" → "VFS-1350". */
export function resolveIssue(cfg: Config, rawKey: string) {
  const key = rawKey.trim().toUpperCase();
  const m = /^([A-Z][A-Z0-9]+)-(\d+)$/.exec(key);
  if (!m) throw new ConfigError(`"${rawKey}" does not look like a Jira key (e.g. VFS-1350).`);
  const project = cfg.jira.projects.find((p) => p.key === m[1]);
  if (!project) {
    const known = cfg.jira.projects.map((p) => p.key).join(", ");
    throw new ConfigError(`The project ${m[1]} is not in the settings (known: ${known}).`);
  }
  return { key, slug: key.toLowerCase(), project };
}
