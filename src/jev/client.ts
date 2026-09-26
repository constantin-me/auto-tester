import { TypeSafeClient, TypeSafeError, type EntryType, type Fetch, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";

/**
 * Thin wrapper over the TypeSafe System One client (Jev).
 *
 * Every call is tagged with a purpose and its token usage is reported to a sink,
 * which is where the M3 budget ledger plugs in (plan Q14).
 */

export interface UsageRecord {
  purpose: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}
export type UsageSink = (usage: UsageRecord) => void;

export interface JudgeOptions {
  model?: string;
  apiKey?: string;
  /** injectable transport, used by tests to run without a key or network */
  fetch?: Fetch;
  onUsage?: UsageSink;
}

export class Judge {
  private readonly client: TypeSafeClient;
  private readonly model?: string;
  private readonly onUsage?: UsageSink;

  constructor(opts: JudgeOptions = {}) {
    try {
      this.client = new TypeSafeClient({ apiKey: opts.apiKey, fetch: opts.fetch, defaultModel: opts.model });
    } catch (err) {
      if (err instanceof TypeSafeError && !opts.apiKey && !process.env.TYPESAFE_API_KEY?.trim()) {
        throw new Error("TYPESAFE_API_KEY is not set. Add it to .env (next to ANTHROPIC_KEY) to run Jev judgments.", {
          cause: err,
        });
      }
      throw err;
    }
    this.model = opts.model;
    this.onUsage = opts.onUsage;
  }

  /** Ask independent questions over one state in a single parallel request. */
  async ask<const Q extends Questions>(purpose: string, state: EntryType, questions: Q): Promise<SystemOneResult<Q>["answers"]> {
    const result = await this.client.systemOne({ state, questions, ...(this.model ? { model: this.model } : {}) });
    this.onUsage?.({
      purpose,
      model: result.model,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
    });
    return result.answers;
  }
}

/** Run `fn` over items with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
