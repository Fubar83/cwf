import type { Agent, AgentEvent, SessionSpec, ToolDef } from "./agent/types.ts";
import type { PrInfo } from "./state.ts";

/** Hur en session slutade. Bestäms alltid av cwf, aldrig av att modellen "säger" att den är klar. */
export type End =
  | { kind: "plan-approved" }
  | { kind: "ready"; prs: PrInfo[] }
  | { kind: "no-change"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "paused"; reason: string }
  | { kind: "budget" }
  | { kind: "hung" }
  | { kind: "gave-up"; reason: string };

/** Det verktygen får för att styra sessionen. */
export interface Control {
  /** Kör en dialog med användaren. Vakten för hängningar står still under tiden. */
  dialog<T>(fn: () => Promise<T>): Promise<T>;
  /** Avslutar sessionen efter att verktyget svarat. */
  end(e: End): void;
}

/** AIC räknas i nano-AIU (1 AIC = 1e9) med BigInt för att undvika avrundningsfel. */
export class Budget {
  spentNano = 0n;
  constructor(
    public limitAic: number,
    private prices: Record<string, { input: number; output: number }>,
  ) {}

  /** USD per miljon tokens → nano-AIU. 1 USD = 100 AIC. */
  add(model: string, inputTokens: number, outputTokens: number) {
    const p = this.prices[model];
    if (!p) return;
    const usdMicro = BigInt(Math.round(inputTokens * p.input + outputTokens * p.output)); // USD * 1e6 / 1e6 tokens
    this.spentNano += usdMicro * 100n * 1000n; // usdMicro/1e6 USD * 100 AIC * 1e9
  }

  get spentAic() {
    return Number(this.spentNano) / 1e9;
  }

  exceeded() {
    return this.spentAic >= this.limitAic;
  }
}

export interface RunOptions {
  prompt: string;
  budget: Budget;
  idleMs: number;
  /** Max antal påminnelser om modellen slutar utan att anropa ett avslutande verktyg. */
  maxNudges?: number;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * Kör en session tills ett verktyg avslutar den, vakten slår till eller budgeten tar slut.
 * Verktygen byggs med `makeTools(control)` så att de kan öppna dialoger och avsluta.
 */
export async function runSession(
  agent: Agent,
  spec: Omit<SessionSpec, "tools">,
  makeTools: (c: Control) => ToolDef[],
  opts: RunOptions,
): Promise<End> {
  let finish!: (e: End) => void;
  const done = new Promise<End>((r) => (finish = r));
  let ended: End | undefined;
  const endOnce = (e: End) => {
    if (ended) return;
    ended = e;
    finish(e);
  };

  let dialogs = 0;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    if (dialogs === 0 && !ended) timer = setTimeout(() => endOnce({ kind: "hung" }), opts.idleMs);
  };

  const control: Control = {
    async dialog(fn) {
      dialogs++;
      if (timer) clearTimeout(timer);
      try {
        return await fn();
      } finally {
        dialogs--;
        arm();
      }
    },
    end: (e) => endOnce(e),
  };

  const startNano = opts.budget.spentNano;
  const session = await agent.createSession({ ...spec, tools: makeTools(control) });
  let nudges = 0;
  const maxNudges = opts.maxNudges ?? 2;

  session.on((e: AgentEvent) => {
    if (ended) return;
    arm();
    switch (e.type) {
      case "usage":
        opts.budget.add(e.model, e.inputTokens, e.outputTokens);
        opts.log?.({ event: "usage", model: e.model, in: e.inputTokens, out: e.outputTokens, aic: opts.budget.spentAic });
        if (opts.budget.exceeded()) endOnce({ kind: "budget" });
        break;
      case "error":
        opts.log?.({ event: "error", message: e.message });
        endOnce({ kind: "gave-up", reason: `Copilot rapporterade ett fel: ${e.message}` });
        break;
      case "idle":
        if (nudges < maxNudges) {
          nudges++;
          opts.log?.({ event: "nudge", n: nudges });
          void session.send(
            "Du har inte avslutat fasen. Avsluta genom att anropa ett av de avslutande verktygen " +
              "(submit_plan, ready_for_pr, report_no_change eller report_blocked). Fortsätt annars arbetet.",
          );
        } else {
          endOnce({ kind: "gave-up", reason: "Copilot slutade utan att anropa ett avslutande verktyg." });
        }
        break;
    }
  });

  arm();
  await session.send(opts.prompt);
  const result = await done;
  if (timer) clearTimeout(timer);

  // Pausen och avslutet är cwf:s beslut: sessionen stoppas oavsett vad modellen vill.
  await session.abort().catch(() => {});
  const total = await session.close().catch(() => undefined);
  // SDK:ns totalsumma för sessionen är sanningen när den finns.
  if (total !== undefined) opts.budget.spentNano = startNano + total;
  opts.log?.({ event: "end", kind: result.kind, aic: opts.budget.spentAic });
  return result;
}
