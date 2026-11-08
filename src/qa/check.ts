import type { Assertion, FlowNode } from "../mindmap/schema.js";
import type { Judge } from "../jev/client.js";
import { judgeObservation, rateSeverity, type Verdict } from "../jev/judgments.js";
import type { PageEvidence, QaSession } from "./driver.js";
import type { JevCache } from "../jev/cache.js";
import { evaluateAssertions, failureText, planComparison, probeSelectors, regressed, textSeen, type AssertionCache, type DecidedBy } from "../compare/compare.js";

/**
 * Check one affected flow against its baseline (M4 slice 2, PER-52/53).
 *
 * Code checks what code can check (status, redirects, new errors, exact text); Jev
 * judges what needs reading: a missing text is confirmed or dismissed with
 * judgeObservation (a label may have moved or been reworded), and every confirmed
 * deviation gets a severity 0–5. Flakiness rule: a deviation of severity >= 3 must
 * repeat on a fresh visit before it is reported as stable; otherwise it is "maybe".
 *
 * Expectations written by the map (PER-47, compare/) join as "expectation" findings, only
 * when the assertion held at baseline and fails at head.
 */

export type FindingKind = "status" | "redirect" | "new-error" | "new-failed-request" | "assertion" | "expectation" | "login";

export interface Finding {
  kind: FindingKind;
  expectation: string;
  actual: string;
  /** Jev verdict for assertion findings */
  verdict?: Verdict;
  severity?: number;
  severityConfidence?: number;
  /** expectation findings (comparator): the assertion that held at baseline and fails now */
  assertionId?: string;
  pinned?: boolean;
  /** expectation findings: a machine check or Jev decided it */
  decidedBy?: DecidedBy;
  /** stable = seen on every attempt; maybe = not reproduced */
  confidence: "stable" | "maybe";
}

export interface FlowCheck {
  flow: string;
  path: string;
  status: "passed" | "failed" | "maybe";
  attempts: number;
  /** expectations evaluated per visit: status, redirect, new errors, new failed requests, texts */
  checksRun: number;
  /** whether the last visit settled before the cap */
  settled: boolean;
  /** comparator: assertions evaluated against head (held at baseline) and ones skipped for lack of a baseline state */
  comparison?: { compared: number; skippedNoBaseline: number };
  findings: Finding[];
  screenshot?: string;
}

/** Jev answer caches for the comparison step (see JevCache); optional. */
export interface CheckCaches {
  observation?: JevCache<{ pSufficient: number; pHolds: number }>;
  severity?: JevCache<{ score: number; confidence: number }>;
  assertions?: AssertionCache;
}

/**
 * Assertions the browser baseline recorded (`qa-observed`): checked directly here. Everything
 * else (`llm-author`, `human`, pinned or not) belongs to the comparator (compare/), which only
 * reports one that held at baseline. The two sets are disjoint by origin, so nothing is
 * checked twice.
 */
export const enforced = (node: FlowNode): Assertion[] => node.assertions.filter((a) => a.provenance.origin === "qa-observed");

async function deviations(
  node: FlowNode,
  compare: { all: Assertion[]; armed: Assertion[] },
  ev: PageEvidence,
  visited: string,
  judge: Judge,
  caches: CheckCaches,
): Promise<Omit<Finding, "confidence">[]> {
  const { armed } = compare;
  const out: Omit<Finding, "confidence">[] = [];
  const base = node.observed;

  if (ev.httpStatus !== undefined && ev.httpStatus >= 400) {
    out.push({ kind: "status", expectation: `${node.route} loads (baseline HTTP ${base?.httpStatus ?? "OK"})`, actual: `HTTP ${ev.httpStatus}` });
    return out; // nothing else is meaningful on an error response
  }
  const redirect = enforced(node).find((a) => a.check?.kind === "url-matches");
  if (redirect && ev.finalPath !== redirect.check!.value) {
    out.push({ kind: "redirect", expectation: redirect.expectation, actual: `ends on ${ev.finalPath}` });
  } else if (!redirect && ev.finalPath !== visited) {
    out.push({ kind: "redirect", expectation: `${node.route} stays on the page`, actual: `redirected to ${ev.finalPath}` });
  }

  const known = new Set(base?.errors ?? []);
  for (const e of ev.observation.consoleErrors ?? []) if (!known.has(e)) out.push({ kind: "new-error", expectation: "no new console or script errors", actual: e });
  const knownFailed = new Set(base?.failedRequests ?? []);
  for (const f of ev.observation.failedRequests ?? []) if (!knownFailed.has(f)) out.push({ kind: "new-failed-request", expectation: "no new failed requests", actual: f });

  // exact text first (free); only misses go to Jev, which can tell a reword from a loss
  const checkable = enforced(node).filter((a): a is Assertion & { check: { kind: "text-present"; value: string } } => a.check?.kind === "text-present");
  for (const a of checkable) {
    if (textSeen(a.check.value, ev)) continue;
    const j = await judgeObservation(judge, a.expectation, ev.observation, undefined, caches.observation);
    if (j.verdict === "match") continue;
    out.push({ kind: "assertion", expectation: a.expectation, actual: `"${a.check.value}" not found on the page`, verdict: j.verdict });
  }

  // comparator: assertions that held at baseline and fail now. Not meaningful when the visit
  // ended on another page (the redirect is already the finding)
  if (!out.some((f) => f.kind === "redirect") && armed.length) {
    // the SAME set baseline evaluated, in the same order: Jev gets an identical question, so an
    // unchanged page is answered from the baseline's cache (free, and cannot flip). Only the
    // armed ones can become findings.
    const head = await evaluateAssertions(judge, node, compare.all, ev, caches.assertions);
    for (const { assertion, decidedBy } of regressed(armed, head)) {
      out.push({
        kind: "expectation",
        expectation: assertion.expectation,
        actual: failureText(assertion, decidedBy),
        assertionId: assertion.id,
        pinned: assertion.pinned,
        decidedBy,
      });
    }
  }
  return out;
}

const keyOf = (f: Omit<Finding, "confidence">) => `${f.kind}|${f.expectation}|${f.actual}`;

export async function checkFlow(
  session: QaSession,
  node: FlowNode,
  path: string,
  judge: Judge,
  opts: { retryCount: number; evidenceDir: string; caches?: CheckCaches },
): Promise<FlowCheck> {
  const caches = opts.caches ?? {};
  const name = node.id.replace(/[^\w-]+/g, "_");
  const { all, armed, skippedNoBaseline } = planComparison(node);
  const compare = { all, armed };
  const probe = { selectors: armed.length ? probeSelectors(all) : [] };
  let ev = await session.visit(path, opts.evidenceDir, name, probe);
  let found = await deviations(node, compare, ev, path, judge, caches);
  let attempts = 1;
  const seen = new Map(found.map((f) => [keyOf(f), 1]));

  // retry while anything was found, up to retryCount more visits
  while (found.length && attempts <= opts.retryCount) {
    attempts++;
    ev = await session.visit(path, opts.evidenceDir, `${name}_retry${attempts - 1}`, probe);
    const again = await deviations(node, compare, ev, path, judge, caches);
    for (const f of again) seen.set(keyOf(f), (seen.get(keyOf(f)) ?? 0) + 1);
    found = [...new Map([...found, ...again].map((f) => [keyOf(f), f])).values()];
  }

  const findings: Finding[] = [];
  for (const f of found) {
    const sev = await rateSeverity(judge, { flow: `${node.label} (${node.route})`, expectation: f.expectation, actual: f.actual }, caches.severity);
    const stable = (seen.get(keyOf(f)) ?? 0) === attempts;
    // one-shot deviations are never reported as bugs; severity >= 3 must repeat
    // a Jev-only failure of an unpinned (model-written) assertion never fails the run alone
    const jevOnly = f.kind === "expectation" && f.decidedBy === "jev" && !f.pinned;
    const confidence: Finding["confidence"] = stable && !jevOnly && (sev.level < 3 || attempts > 1) ? "stable" : "maybe";
    findings.push({ ...f, severity: sev.level, severityConfidence: sev.confidence, confidence });
  }

  const status: FlowCheck["status"] = findings.some((f) => f.confidence === "stable") ? "failed" : findings.length ? "maybe" : "passed";
  const checksRun = 4 + enforced(node).filter((a) => a.check?.kind === "text-present").length + armed.length;
  return { flow: node.id, path, status, attempts, checksRun, settled: ev.settled, comparison: { compared: armed.length, skippedNoBaseline }, findings, screenshot: ev.screenshot };
}
