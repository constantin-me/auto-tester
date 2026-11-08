import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { EnrichOutput } from "./schema.js";

/** One model call's worth of input. Injectable so tests never touch the network. */
export interface EnrichRequest {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  system: string;
  user: string;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}
export type EnrichResponse =
  | { ok: true; output: EnrichOutput; usage: Usage }
  | { ok: false; reason: string; usage?: Usage };

export interface EnrichClient {
  enrich(req: EnrichRequest): Promise<EnrichResponse>;
}

/** Real client. Reads ANTHROPIC_API_KEY from the environment; the key is never logged. */
export function anthropicClient(client: Anthropic = new Anthropic()): EnrichClient {
  return {
    async enrich(req) {
      // no thinking / temperature / budget_tokens params: this model rejects them
      const msg = await client.messages.parse({
        model: req.model,
        max_tokens: 16000,
        system: req.system,
        output_config: { format: zodOutputFormat(EnrichOutput), effort: req.effort },
        messages: [{ role: "user", content: req.user }],
      });
      const usage = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
      // stop_reason first: a refusal or a cut-off answer has content that must not be read as the answer
      if (msg.stop_reason === "refusal") return { ok: false, reason: "model refused", usage };
      if (msg.stop_reason === "max_tokens") return { ok: false, reason: "answer cut off at max_tokens", usage };
      if (!msg.parsed_output) return { ok: false, reason: "no parsed output (schema mismatch)", usage };
      return { ok: true, output: msg.parsed_output, usage };
    },
  };
}
