import { z } from "zod/v4";

/**
 * What Claude returns for one node. Built on zod/v4 (shipped inside zod 3.25) because the
 * SDK's `zodOutputFormat` helper takes v4 types; the rest of the repo stays on zod 3.
 *
 * Structured outputs do not enforce numeric ranges, so `severityIfBroken` and `confidence`
 * are clamped by `normalize` rather than trusted.
 */
export const EnrichOutput = z.object({
  /** short human page name, e.g. "Collection dashboard" */
  label: z.string(),
  /** 0..1: how sure the model is it understood this page from the code alone */
  confidence: z.number(),
  assertions: z.array(
    z.object({
      /** 2-5 word kebab-case summary, used to build a stable id */
      slug: z.string(),
      /** natural-language statement of expected behavior */
      expectation: z.string(),
      /** only when the evidence contains a literal value to check; otherwise null */
      check: z
        .object({
          kind: z.enum(["selector-visible", "text-present", "url-matches", "status-ok", "custom"]),
          value: z.string(),
        })
        .nullable(),
      /** 0 cosmetic .. 5 page unusable / data loss */
      severityIfBroken: z.number(),
    }),
  ),
});
export type EnrichOutput = z.infer<typeof EnrichOutput>;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

export function normalize(out: EnrichOutput): EnrichOutput {
  return {
    label: out.label.trim().replace(/\s+/g, " "),
    confidence: clamp(out.confidence, 0, 1),
    assertions: out.assertions
      .filter((a) => a.expectation.trim())
      .map((a) => ({
        ...a,
        expectation: a.expectation.trim(),
        severityIfBroken: Math.round(clamp(a.severityIfBroken, 0, 5)),
      })),
  };
}
