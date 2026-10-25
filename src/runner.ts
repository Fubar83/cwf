import type { Agent, AgentEvent, SessionSpec, ToolDef } from "./agent/types.ts";
import type { PrInfo } from "./state.ts";

/** How a session ended. Always decided by cwf, never by the model "saying" it is done. */
export type End =
  | { kind: "plan-approved" }
  | { kind: "ready"; prs: PrInfo[] }
  | { kind: "no-change"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "paused"; reason: string }
  | { kind: "budget" }
  | { kind: "hung" }
  | { kind: "gave-up"; reason: string };

/** What a tool may use to steer the session. */
export interface Control {
  /** Runs a dialog with the user. The hang watchdog stands still meanwhile. */
  dialog<T>(fn: () => Promise<T>): Promise<T>;
  /** Ends the session after the tool has replied. */
  end(e: End): void;
}

/** AIC is counted in nano-AIU (1 AIC = 1e9) using BigInt to avoid rounding errors. */
export class Budget {
  spentNano = 0n;
  constructor(
    public limitAic: number,
    private prices: Record<string, { input: number; output: number }>,
  ) {}

  /** USD per million tokens → nano-AIU. 1 USD = 100 AIC. */
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
  /** Max number of reminders when the model stops without calling an ending tool. */
  maxNudges?: number;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * Runs a session until a tool ends it, the watchdog fires, or the budget runs out.
 * The tools are built with `makeTools(control)` so they can open dialogs and end the session.
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
        endOnce({ kind: "gave-up", reason: `Copilot reported an error: ${e.message}` });
        break;
      case "idle":
        if (nudges < maxNudges) {
          nudges++;
          opts.log?.({ event: "nudge", n: nudges });
          void session.send(
            "You have not finished the phase. End it by calling one of the ending tools " +
              "(submit_plan, ready_for_pr, report_no_change or report_blocked). Otherwise keep working.",
          );
        } else {
          endOnce({ kind: "gave-up", reason: "Copilot stopped without calling an ending tool." });
        }
        break;
    }
  });

  arm();
  await session.send(opts.prompt);
  const result = await done;
  if (timer) clearTimeout(timer);

  // Pausing and ending are cwf's decisions: the session is stopped whatever the model wants.
  await session.abort().catch(() => {});
  const total = await session.close().catch(() => undefined);
  // The SDK's total for the session is the truth when it exists.
  if (total !== undefined) opts.budget.spentNano = startNano + total;
  opts.log?.({ event: "end", kind: result.kind, aic: opts.budget.spentAic });
  return result;
}
