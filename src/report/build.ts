import { relative } from "node:path";
import type { FlowNode } from "../mindmap/schema.js";
import type { Triage } from "../jev/judgments.js";
import type { UsageRecord } from "../jev/client.js";
import type { FlowCheck } from "../qa/check.js";
import { confidenceOf, notTestedBucket, Report, SEVERITY_LABELS, verdictOf, type FlowReport } from "./report.js";

/** One candidate as judged by Jev in a check run. */
export interface JudgedCandidate {
  node: FlowNode;
  reasons: string[];
  files: string[];
  triage: Triage;
  pDiffers?: number;
  affected: boolean;
}

/** A flow that was affected but not visited (skipped, no data, unreachable). */
export interface NotVisited {
  flow: string;
  path?: string;
  status: string;
  reason: string;
}

/** A candidate the token cap stopped from being judged at all. */
export interface Untriaged {
  node: FlowNode;
  reasons: string[];
  files: string[];
}

export const BUDGET_NOT_TRIAGED = "budget: token cap reached before Jev could judge whether the change affects it";
export const BUDGET_NOT_VISITED = "budget: token cap reached before it was visited";

export interface BuildInput {
  repo: string;
  target: string;
  generatedAt: string;
  changedFiles: string[];
  judged: JudgedCandidate[];
  untriaged: Untriaged[];
  /** login failed at check time (qa/login-gate.ts): reported on the login flow even if triage never picked it */
  gate?: { node?: FlowNode; check: FlowCheck };
  budget: { cap: number; spent: number; reserveForChecks: number };
  results: (FlowCheck | NotVisited)[];
  executionCheck: boolean;
  dropBelow: number;
  usage: UsageRecord[];
  evidenceDir: string;
}

const isCheck = (r: FlowCheck | NotVisited): r is FlowCheck => "findings" in r;
const p2 = (x: number) => x.toFixed(2);

export function buildReport(input: BuildInput): Report {
  const resultOf = new Map(input.results.map((r) => [r.flow, r]));
  const gateFlow = input.gate?.check.flow;
  // a failed login is reported on the login flow whatever triage said about it
  const judged: JudgedCandidate[] = input.judged.map((j) => (j.node.id === gateFlow ? { ...j, affected: true } : j));
  if (input.gate && !judged.some((j) => j.node.id === gateFlow)) {
    const node: FlowNode = input.gate.node ?? {
      id: input.gate.check.flow,
      label: "Login",
      route: input.gate.check.path,
      views: [],
      kind: "page",
      requiresAuth: false,
      guards: [],
      assertions: [],
      provenance: { sourceFiles: [], origin: "static-crawl", confidence: 1 },
    };
    judged.push({
      node,
      reasons: ["login is the gate to every other flow"],
      files: [],
      triage: { pRuns: 1, pAlters: 1, impact: 3, value: 1 } as JudgedCandidate["triage"],
      affected: true,
    });
  }
  const flows: FlowReport[] = judged.map((j) => {
    const base = {
      flow: j.node.id,
      label: j.node.label,
      route: j.node.route,
      why: j.reasons.slice(0, 5),
      likelyCause: j.files,
      jev: { pRuns: j.triage.pRuns, pAlters: j.triage.pAlters, impact: j.triage.impact, value: j.triage.value, pDiffers: j.pDiffers },
      findings: [],
    };
    if (!j.affected) {
      const reason =
        j.triage.affected && j.pDiffers !== undefined
          ? `execution check: P(the change gives this flow a different result) = ${p2(j.pDiffers)}, below ${input.dropBelow}`
          : `Jev: not affected (P(runs)=${p2(j.triage.pRuns)}, P(alters)=${p2(j.triage.pAlters)})`;
      return { ...base, outcome: "not-tested" as const, notTestedReason: reason };
    }
    const r = resultOf.get(j.node.id);
    if (!r) return { ...base, outcome: "not-tested" as const, notTestedReason: "not planned for a visit" };
    if (!isCheck(r)) {
      const budget = r.status === "skipped-budget" ? { notTestedStatus: "skipped-budget" as const } : {};
      return { ...base, path: r.path, outcome: "not-tested" as const, notTestedReason: r.reason, ...budget };
    }

    const outcome = r.status === "failed" ? ("failed" as const) : r.status === "maybe" ? ("maybe" as const) : ("passed" as const);
    const checks = { run: r.checksRun, attempts: r.attempts, settled: r.settled };
    return {
      ...base,
      path: r.path,
      outcome,
      ...confidenceOf(outcome, checks),
      checks,
      comparison: r.comparison,
      findings: r.findings.map((f) => ({
        kind: f.kind,
        expected: f.expectation,
        actual: f.actual,
        severity: f.severity ?? 0,
        severityLabel: SEVERITY_LABELS[f.severity ?? 0] ?? "unrated",
        reproduced: f.confidence,
        ...(f.kind === "expectation" ? { assertionId: f.assertionId, pinned: f.pinned ?? false, heldAtBaseline: true } : {}),
      })),
      screenshot: r.screenshot ? relative(input.evidenceDir, r.screenshot) : undefined,
    };
  });

  // candidates the cap never let Jev look at: recorded, not dropped
  for (const u of input.untriaged) {
    flows.push({
      flow: u.node.id,
      label: u.node.label,
      route: u.node.route,
      why: u.reasons.slice(0, 5),
      likelyCause: u.files,
      findings: [],
      outcome: "not-tested",
      notTestedReason: BUDGET_NOT_TRIAGED,
      notTestedStatus: "skipped-budget",
    });
  }

  // most important first: failures by worst severity, then uncertain, passed, not tested
  const rank = { failed: 0, maybe: 1, passed: 2, "not-tested": 3 };
  const worst = (f: FlowReport) => Math.max(-1, ...f.findings.map((x) => x.severity));
  flows.sort((a, b) => rank[a.outcome] - rank[b.outcome] || worst(b) - worst(a) || (b.jev?.value ?? 0) - (a.jev?.value ?? 0));

  const notTested = flows.filter((f) => f.outcome === "not-tested");
  const notTestedBy: Record<string, number> = {};
  for (const f of notTested) notTestedBy[notTestedBucket(f.notTestedReason ?? "")] = (notTestedBy[notTestedBucket(f.notTestedReason ?? "")] ?? 0) + 1;

  const notVisited = flows.filter((f) => f.notTestedStatus === "skipped-budget").length - input.untriaged.length;

  return Report.parse({
    schemaVersion: 1,
    advisory: true,
    generatedAt: input.generatedAt,
    repo: input.repo,
    target: input.target,
    changedFiles: input.changedFiles,
    verdict: verdictOf(flows),
    summary: {
      candidates: input.judged.length + input.untriaged.length,
      affected: input.judged.filter((j) => j.affected).length,
      tested: flows.filter((f) => f.outcome !== "not-tested").length,
      failed: flows.filter((f) => f.outcome === "failed").length,
      maybe: flows.filter((f) => f.outcome === "maybe").length,
      passed: flows.filter((f) => f.outcome === "passed").length,
      notTested: notTested.length,
      notTestedBy,
      executionCheck: input.executionCheck,
      comparison: flows.reduce(
        (t, f) => ({ compared: t.compared + (f.comparison?.compared ?? 0), skippedNoBaseline: t.skippedNoBaseline + (f.comparison?.skippedNoBaseline ?? 0) }),
        { compared: 0, skippedNoBaseline: 0 },
      ),
    },
    flows,
    jev: {
      requests: input.usage.length,
      tokens: input.usage.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0),
      model: input.usage[0]?.model,
    },
    budget: {
      ...input.budget,
      partial: input.untriaged.length + notVisited > 0,
      notTriaged: input.untriaged.length,
      notVisited,
    },
    evidenceDir: input.evidenceDir,
  });
}
