import { z } from "zod";

/**
 * The run report (M5, PER-55): one JSON document per check run, for tooling and for
 * LLMs, rendered to markdown by markdown.ts. Advisory by construction: it describes,
 * it never gates (plan Q2).
 */

export const SEVERITY_LABELS = [
  "non-blocking, minor",
  "minor",
  "moderate",
  "major",
  "critical",
  "release blocker",
] as const;

export const ReportFinding = z.object({
  kind: z.enum(["status", "redirect", "new-error", "new-failed-request", "assertion"]),
  expected: z.string(),
  actual: z.string(),
  severity: z.number().int().min(0).max(5),
  severityLabel: z.string(),
  /** stable = seen on every visit; maybe = not reproduced, never reported as a bug */
  reproduced: z.enum(["stable", "maybe"]),
});
export type ReportFinding = z.infer<typeof ReportFinding>;

export const FlowReport = z.object({
  flow: z.string(),
  label: z.string(),
  route: z.string().optional(),
  /** concrete path visited */
  path: z.string().optional(),
  outcome: z.enum(["failed", "maybe", "passed", "not-tested"]),
  /** for tested flows: how much the outcome can be trusted, and why */
  confidence: z.enum(["high", "medium", "low"]).optional(),
  confidenceWhy: z.string().optional(),
  notTestedReason: z.string().optional(),
  /** why the flow was considered: how the change reached it */
  why: z.array(z.string()),
  /** changed files that linked this flow: the likely origin of any finding */
  likelyCause: z.array(z.string()),
  jev: z
    .object({
      pRuns: z.number(),
      pAlters: z.number(),
      impact: z.number(),
      value: z.number(),
      pDiffers: z.number().optional(),
    })
    .optional(),
  checks: z.object({ run: z.number(), attempts: z.number(), settled: z.boolean() }).optional(),
  findings: z.array(ReportFinding),
  screenshot: z.string().optional(),
});
export type FlowReport = z.infer<typeof FlowReport>;

export const Report = z.object({
  schemaVersion: z.literal(1),
  advisory: z.literal(true),
  generatedAt: z.string(),
  repo: z.string(),
  target: z.string(),
  changedFiles: z.array(z.string()),
  verdict: z.enum(["likely-regression", "possible-issue", "no-regression-found", "nothing-tested"]),
  summary: z.object({
    candidates: z.number(),
    affected: z.number(),
    tested: z.number(),
    failed: z.number(),
    maybe: z.number(),
    passed: z.number(),
    notTested: z.number(),
    /** not-tested reasons, bucketed */
    notTestedBy: z.record(z.number()),
    executionCheck: z.boolean(),
  }),
  flows: z.array(FlowReport),
  jev: z.object({ requests: z.number(), tokens: z.number(), model: z.string().optional() }),
  evidenceDir: z.string(),
});
export type Report = z.infer<typeof Report>;

/** Outcome confidence, stated with its reason rather than as a bare number. */
export function confidenceOf(outcome: FlowReport["outcome"], checks: { run: number; attempts: number; settled: boolean }) {
  if (outcome === "failed") {
    return { confidence: "high" as const, confidenceWhy: `reproduced on all ${checks.attempts} visits` };
  }
  if (outcome === "maybe") {
    return { confidence: "low" as const, confidenceWhy: "a deviation was seen but not reproduced on every visit" };
  }
  if (!checks.settled) {
    return { confidence: "medium" as const, confidenceWhy: `${checks.run} expectations held, but the page did not fully settle before the time cap` };
  }
  if (checks.run < 6) {
    return { confidence: "medium" as const, confidenceWhy: `only ${checks.run} expectations recorded for this page` };
  }
  return { confidence: "high" as const, confidenceWhy: `all ${checks.run} expectations held on a settled page` };
}

/** Coarse bucket for a not-tested reason, for the summary counts. */
export function notTestedBucket(reason: string): string {
  if (reason.startsWith("execution check")) return "execution check: change does not reach it";
  if (reason.startsWith("Jev")) return "Jev: not affected";
  if (reason.includes("404")) return "unreachable on this instance";
  if (reason.includes("no live link")) return "no data to open it";
  if (reason.includes("endpoint")) return "endpoint (not visited)";
  if (reason.includes("deny")) return "on the deny list";
  return "other";
}

export function verdictOf(flows: FlowReport[]): Report["verdict"] {
  const tested = flows.filter((f) => f.outcome !== "not-tested");
  if (!tested.length) return "nothing-tested";
  if (tested.some((f) => f.outcome === "failed" && f.findings.some((x) => x.reproduced === "stable" && x.severity >= 3))) return "likely-regression";
  if (tested.some((f) => f.outcome === "failed" || f.outcome === "maybe")) return "possible-issue";
  return "no-regression-found";
}
