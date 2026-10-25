import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

export interface Choice<T extends string> {
  value: T;
  label: string;
}

/** Svar från en dialog. `timeout` betyder att användaren inte svarade i tid och cwf ska pausa. */
export type Reply<T> = { kind: "ok"; value: T } | { kind: "timeout" };

/** Allt cwf visar eller frågar går genom UI, så att tester kan byta ut det. */
export interface UI {
  info(msg: string): void;
  warn(msg: string): void;
  heading(msg: string): void;
  select<T extends string>(question: string, choices: Choice<T>[]): Promise<Reply<T>>;
  text(question: string): Promise<Reply<string>>;
  /** Öppnar $EDITOR med given text och returnerar resultatet. */
  editor(initial: string): Promise<Reply<string>>;
}

const c = {
  bold: (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  yellow: (s: string) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (process.stdout.isTTY ? `\x1b[36m${s}\x1b[0m` : s),
};

export class TerminalUI implements UI {
  constructor(private waitMs: number) {}

  info(msg: string) {
    console.log(msg);
  }
  warn(msg: string) {
    console.log(c.yellow(`! ${msg}`));
  }
  heading(msg: string) {
    console.log(`\n${c.bold(c.cyan(msg))}`);
  }

  private async ask(prompt: string): Promise<Reply<string>> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.waitMs);
    try {
      const value = await rl.question(prompt, { signal: ac.signal });
      return { kind: "ok", value };
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        console.log(c.dim("\n(ingen aktivitet – pausar)"));
        return { kind: "timeout" };
      }
      throw e;
    } finally {
      clearTimeout(timer);
      rl.close();
    }
  }

  async select<T extends string>(question: string, choices: Choice<T>[]): Promise<Reply<T>> {
    console.log(`\n${c.bold(question)}`);
    choices.forEach((ch, i) => console.log(`  ${i + 1}) ${ch.label}`));
    for (;;) {
      const r = await this.ask("Val: ");
      if (r.kind === "timeout") return r;
      const n = Number(r.value.trim());
      const picked = choices[n - 1];
      if (Number.isInteger(n) && picked) return { kind: "ok", value: picked.value };
      console.log(`Skriv en siffra mellan 1 och ${choices.length}.`);
    }
  }

  async text(question: string): Promise<Reply<string>> {
    return this.ask(`${question}\n> `);
  }

  async editor(initial: string): Promise<Reply<string>> {
    const dir = mkdtempSync(join(tmpdir(), "cwf-"));
    const file = join(dir, "cwf.md");
    writeFileSync(file, initial);
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const r = spawnSync("bash", ["-lc", `${editor} "$1"`, "_", file], { stdio: "inherit" });
    const value = readFileSync(file, "utf8");
    rmSync(dir, { recursive: true, force: true });
    if (r.status !== 0) throw new Error(`Editorn (${editor}) avslutades med fel.`);
    return { kind: "ok", value };
  }
}

/** Skriptad UI för tester: svaren tas i ordning. Slut på svar = timeout (paus). */
export class ScriptedUI implements UI {
  readonly output: string[] = [];
  constructor(private answers: string[]) {}
  info(m: string) {
    this.output.push(m);
  }
  warn(m: string) {
    this.output.push(`! ${m}`);
  }
  heading(m: string) {
    this.output.push(`# ${m}`);
  }
  private next(): Reply<string> {
    const v = this.answers.shift();
    return v === undefined ? { kind: "timeout" } : { kind: "ok", value: v };
  }
  async select<T extends string>(q: string, choices: Choice<T>[]): Promise<Reply<T>> {
    this.output.push(`? ${q}`);
    const r = this.next();
    if (r.kind === "timeout") return r;
    const hit = choices.find((ch) => ch.value === r.value);
    if (!hit) throw new Error(`ScriptedUI: "${r.value}" finns inte bland ${choices.map((c) => c.value)}`);
    return { kind: "ok", value: hit.value };
  }
  async text(q: string) {
    this.output.push(`? ${q}`);
    return this.next();
  }
  async editor(_initial: string) {
    return this.next();
  }
}
