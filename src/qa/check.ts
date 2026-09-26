import type { Assertion, FlowNode } from "../mindmap/schema.js";
import type { Judge } from "../jev/client.js";
import { judgeObservation, rateSeverity, type Verdict } from "../jev/judgments.js";
import type { PageEvidence, QaSession } from "./driver.js";

/**
 * Check one affected flow against its baseline (M4 slice 2, PER-52/53).
 *
 * Code checks what code can check (status, redirects, new errors, exact text); Jev
 * judges what needs reading: a missing text is confirmed or dismissed with
 * judgeObservation (a label may have moved or been reworded), and every confirmed
 * deviation gets a severity 0–5. Flakiness rule: a deviation of severity >= 3 must
 * repeat on a fresh visit before it is reported as stable; otherwise it is "maybe".
 */

export type FindingKind = "status" | "redirect" | "new-error" | "new-failed-request" | "assertion";

export interface Finding {
  kind: FindingKind;
  expectation: string;
  actual: string;
  /** Jev verdict for assertion findings */
  verdict?: Verdict;
  severity?: number;
  severityConfidence?: number;
  /** stable = seen on every attempt; maybe = not reproduced */
  confidence: "stable" | "maybe";
}

export interface FlowCheck {
  flow: string;
  path: string;
  status: "passed" | "failed" | "maybe";
  attempts: number;
  findings: Finding[];
  screenshot?: string;
}

const textSeen = (value: string, ev: PageEvidence) =>
  ev.observation.text.includes(value) ||
  ev.structure.headings.includes(value) ||
  ev.structure.buttons.includes(value) ||
  ev.structure.labels.includes(value);

/** Deviations from one visit, before retries and severity. */
async function deviations(node: FlowNode, ev: PageEvidence, visited: string, judge: Judge): Promise<Omit<Finding, "confidence">[]> {
  const out: Omit<Finding, "confidence">[] = [];
  const base = node.observed;

  if (ev.httpStatus !== undefined && ev.httpStatus >= 400) {
    out.push({ kind: "status", expectation: `${node.route} loads (baseline HTTP ${base?.httpStatus ?? "OK"})`, actual: `HTTP ${ev.httpStatus}` });
    return out; // nothing else is meaningful on an error response
  }
  const redirect = node.assertions.find((a) => a.check?.kind === "url-matches");
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
  const checkable = node.assertions.filter((a): a is Assertion & { check: { kind: "text-present"; value: string } } => a.check?.kind === "text-present");
  for (const a of checkable) {
    if (textSeen(a.check.value, ev)) continue;
    const j = await judgeObservation(judge, a.expectation, ev.observation);
    if (j.verdict === "match") continue;
    out.push({ kind: "assertion", expectation: a.expectation, actual: `"${a.check.value}" not found on the page`, verdict: j.verdict });
  }
  return out;
}

const keyOf = (f: Omit<Finding, "confidence">) => `${f.kind}|${f.expectation}|${f.actual}`;

export async function checkFlow(
  session: QaSession,
  node: FlowNode,
  path: string,
  judge: Judge,
  opts: { retryCount: number; evidenceDir: string },
): Promise<FlowCheck> {
  const name = node.id.replace(/[^\w-]+/g, "_");
  let ev = await session.visit(path, opts.evidenceDir, name);
  let found = await deviations(node, ev, path, judge);
  let attempts = 1;
  const seen = new Map(found.map((f) => [keyOf(f), 1]));

  // retry while anything was found, up to retryCount more visits
  while (found.length && attempts <= opts.retryCount) {
    attempts++;
    ev = await session.visit(path, opts.evidenceDir, `${name}_retry${attempts - 1}`);
    const again = await deviations(node, ev, path, judge);
    for (const f of again) seen.set(keyOf(f), (seen.get(keyOf(f)) ?? 0) + 1);
    found = [...new Map([...found, ...again].map((f) => [keyOf(f), f])).values()];
  }

  const findings: Finding[] = [];
  for (const f of found) {
    const sev = await rateSeverity(judge, { flow: `${node.label} (${node.route})`, expectation: f.expectation, actual: f.actual });
    const stable = (seen.get(keyOf(f)) ?? 0) === attempts;
    // one-shot deviations are never reported as bugs; severity >= 3 must repeat
    const confidence: Finding["confidence"] = stable && (sev.level < 3 || attempts > 1) ? "stable" : "maybe";
    findings.push({ ...f, severity: sev.level, severityConfidence: sev.confidence, confidence });
  }

  const status: FlowCheck["status"] = findings.some((f) => f.confidence === "stable") ? "failed" : findings.length ? "maybe" : "passed";
  return { flow: node.id, path, status, attempts, findings, screenshot: ev.screenshot };
}
