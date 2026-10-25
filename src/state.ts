import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
  appendFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod/v4";

export const Phase = z.enum(["plan", "build", "publish", "done", "blocked"]);
export type Phase = z.infer<typeof Phase>;

export const Question = z.object({
  id: z.string(),
  question: z.string(),
  investigated: z.string(),
  options: z
    .array(z.object({ label: z.string(), consequence: z.string() }))
    .min(2)
    .max(4),
  recommendation: z.string(),
  why: z.string(),
});
export type Question = z.infer<typeof Question>;

export const Answer = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string(),
  at: z.string(),
});
export type Answer = z.infer<typeof Answer>;

export const PrInfo = z.object({
  repo: z.string(),
  title: z.string(),
  body: z.string(),
  dependsOn: z.array(z.string()).default([]),
});
export type PrInfo = z.infer<typeof PrInfo>;

export const StateSchema = z.object({
  schema: z.literal(1),
  key: z.string(),
  repos: z.array(z.string()),
  branch: z.string(),
  phase: Phase,
  issueHash: z.string().optional(),
  notes: z.array(z.object({ at: z.string(), text: z.string() })).default([]),
  pendingQuestions: z.array(Question).default([]),
  answers: z.array(Answer).default([]),
  plan: z
    .object({
      version: z.number().int(),
      approved: z.boolean(),
      feedback: z.array(z.string()).default([]),
    })
    .optional(),
  buildRounds: z.number().int().default(0),
  blockedReason: z.string().optional(),
  prs: z.array(PrInfo).default([]),
  publish: z
    .record(
      z.string(),
      z.object({
        pushed: z.boolean().default(false),
        prUrl: z.string().optional(),
        ready: z.boolean().default(false),
      }),
    )
    .default({}),
  aic: z.object({ total: z.number().default(0) }).prefault({}),
});
export type State = z.infer<typeof StateSchema>;

/** Skriver atomiskt: temp-fil, fsync, rename. Ett avbrott lämnar alltid den gamla eller nya filen hel. */
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Allt wf sparar för ett ärende ligger i <ärendekatalog>/.wf/. */
export class Store {
  constructor(readonly dir: string) {}

  static forIssue(issueDir: string) {
    return new Store(join(issueDir, ".wf"));
  }

  path(...parts: string[]) {
    return join(this.dir, ...parts);
  }

  exists() {
    return existsSync(this.path("state.json"));
  }

  load(): State {
    const raw = JSON.parse(readFileSync(this.path("state.json"), "utf8"));
    const parsed = StateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `state.json är skadad eller från en annan wf-version: ${parsed.error.issues[0]?.message}`,
      );
    }
    return parsed.data;
  }

  save(state: State) {
    writeAtomic(this.path("state.json"), JSON.stringify(state, null, 2) + "\n");
  }

  write(name: string, content: string) {
    writeAtomic(this.path(name), content);
  }

  read(name: string): string | undefined {
    const p = this.path(name);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }

  /** Lägger till en rad (JSON Lines). Loggning får aldrig stoppa flödet. */
  log(name: string, entry: unknown) {
    try {
      const p = this.path(name);
      mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...(entry as object) }) + "\n");
    } catch {
      /* ignoreras */
    }
  }
}

export class LockedError extends Error {}

/**
 * Enkelt lås per ärende. Skapas exklusivt (O_EXCL). Ett lås från en process som
 * inte längre lever på samma värd tas över.
 */
export function acquireLock(store: Store): () => void {
  mkdirSync(store.dir, { recursive: true });
  const p = store.path("lock");
  const me = { pid: process.pid, host: hostname(), started: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, "wx");
      writeSync(fd, JSON.stringify(me));
      closeSync(fd);
      return () => rmSync(p, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let other: { pid: number; host: string; started: string } | undefined;
      try {
        other = JSON.parse(readFileSync(p, "utf8"));
      } catch {
        /* trasigt lås: ta över */
      }
      if (other && other.host === me.host && isAlive(other.pid)) {
        throw new LockedError(
          `Ärendet körs redan (pid ${other.pid}, startad ${other.started}).`,
        );
      }
      if (other && other.host !== me.host) {
        throw new LockedError(
          `Ärendet är låst från en annan värd (${other.host}). Ta bort ${p} om det är fel.`,
        );
      }
      rmSync(p, { force: true });
    }
  }
  throw new LockedError(`Kunde inte ta låset ${p}.`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
