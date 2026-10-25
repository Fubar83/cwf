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

/** Writes atomically: temp file, fsync, rename. An interruption always leaves the old or the new file intact. */
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

/** Everything cwf saves for an issue lives in <issue directory>/.cwf/. */
export class Store {
  constructor(readonly dir: string) {}

  static forIssue(issueDir: string) {
    return new Store(join(issueDir, ".cwf"));
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
        `state.json is corrupt or from another cwf version: ${parsed.error.issues[0]?.message}`,
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

  /** Appends a line (JSON Lines). Logging must never stop the flow. */
  log(name: string, entry: unknown) {
    try {
      const p = this.path(name);
      mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...(entry as object) }) + "\n");
    } catch {
      /* ignored */
    }
  }
}

export class LockedError extends Error {}

/**
 * A simple lock per issue, created exclusively (O_EXCL). A lock left by a process that
 * is no longer alive on the same host is taken over.
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
        /* broken lock: take it over */
      }
      if (other && other.host === me.host && isAlive(other.pid)) {
        throw new LockedError(
          `The issue is already running (pid ${other.pid}, started ${other.started}).`,
        );
      }
      if (other && other.host !== me.host) {
        throw new LockedError(
          `The issue is locked from another host (${other.host}). Delete ${p} if that is wrong.`,
        );
      }
      rmSync(p, { force: true });
    }
  }
  throw new LockedError(`Could not take the lock ${p}.`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
