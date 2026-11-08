import { mapLimit, type UsageRecord } from "../jev/client.js";

/**
 * Token budget for one run (PER-48). Every Jev call is debited through `debit`, wired
 * as the Judge's `onUsage` sink. Past the cap nothing new *starts*; whatever is already
 * running finishes and is debited. Nothing is ever killed mid-flow.
 *
 * The cap is soft. A call's cost is only known when it returns, so work that started
 * before the cap was crossed can still push `spent` over it. The overshoot is bounded
 * by what was in flight at that moment:
 *   - triage/execution: one request per worker at a time, so at most `jev.concurrency`
 *     requests;
 *   - visits: a started flow runs to the end and may make several observation/severity
 *     calls, so at most `qa.concurrency` flows' worth of calls.
 *
 * Starvation: triage runs for every candidate before any visit, so it could eat the whole
 * cap. `reserveForChecks` (0..1) is the share of the cap triage + execution may not touch;
 * only the visit phase can spend it.
 */
export type Phase = "triage" | "check";

export class BudgetLedger {
  private total = 0;
  private readonly purposes = new Map<string, number>();

  constructor(
    readonly cap: number,
    /** fraction of the cap kept back for the visit phase */
    readonly reserveForChecks = 0,
  ) {
    if (!(cap > 0)) throw new Error("budget cap must be positive");
    if (!(reserveForChecks >= 0 && reserveForChecks <= 1)) throw new Error("reserveForChecks must be within 0..1");
  }

  /** Bound `UsageSink`: pass as `onUsage`. */
  readonly debit = (usage: UsageRecord): void => {
    const tokens = usage.inputTokens + usage.outputTokens;
    this.total += tokens;
    this.purposes.set(usage.purpose, (this.purposes.get(usage.purpose) ?? 0) + tokens);
  };

  get spent(): number {
    return this.total;
  }
  get remaining(): number {
    return Math.max(0, this.cap - this.total);
  }
  get exhausted(): boolean {
    return this.total >= this.cap;
  }
  /** tokens spent per Jev purpose ("triage", "execution", ...) */
  get byPurpose(): Record<string, number> {
    return Object.fromEntries(this.purposes);
  }

  /** Cap for a phase: triage + execution stop at the reserve line, visits at the cap. */
  limitFor(phase: Phase): number {
    return phase === "triage" ? this.cap * (1 - this.reserveForChecks) : this.cap;
  }

  /** May new work start in this phase? Running work is never asked. */
  mayStart(phase: Phase): boolean {
    return this.total < this.limitFor(phase);
  }
}

export type Gated<R> = { started: true; value: R } | { started: false };

/**
 * mapLimit that checks the ledger right before each item starts. Items refused are
 * returned as `{ started: false }` (never dropped); items already running finish.
 * `free` lets an item through regardless: a cached answer costs nothing.
 */
export async function mapGated<T, R>(
  items: T[],
  limit: number,
  ledger: BudgetLedger,
  phase: Phase,
  fn: (item: T, index: number) => Promise<R>,
  free: (item: T) => boolean = () => false,
): Promise<Gated<R>[]> {
  return mapLimit(items, limit, async (item, i): Promise<Gated<R>> => {
    if (!ledger.mayStart(phase) && !free(item)) return { started: false };
    return { started: true, value: await fn(item, i) };
  });
}
