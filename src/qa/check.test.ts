import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow, enforced } from "./check.js";
import { Judge } from "../jev/client.js";
import type { Assertion, FlowNode } from "../mindmap/schema.js";
import type { PageEvidence, QaSession } from "./driver.js";

const a = (id: string, origin: Assertion["provenance"]["origin"], pinned = false, check: Assertion["check"] = { kind: "text-present", value: id }): Assertion => ({
  id,
  expectation: id,
  check,
  severityIfBroken: 3,
  pinned,
  provenance: { sourceFiles: [], origin, confidence: 0.5 },
});
const nodeWith = (assertions: Assertion[], assertionStates?: Record<string, "holds" | "fails" | "unobservable">): FlowNode =>
  ({
    id: "node:a",
    label: "A",
    route: "/a",
    views: [],
    kind: "page",
    requiresAuth: false,
    guards: [],
    assertions,
    provenance: { sourceFiles: [], origin: "static-crawl", confidence: 0.5 },
    observed: { at: "t", status: "reachable", assertionStates },
  }) satisfies FlowNode;

test("check mode enforces only the browser baseline: the comparator owns pinned and LLM assertions", () => {
  const node = nodeWith([a("observed", "qa-observed"), a("llm", "llm-author"), a("llm-pinned", "llm-author", true), a("human-pinned", "human", true)]);
  assert.deepEqual(enforced(node).map((x) => x.id), ["observed"]);
});

// ---- checkFlow with a fake browser and a fake Jev --------------------------------

const ev = (over: Partial<PageEvidence> = {}): PageEvidence => ({
  observation: { url: "/a", text: "Hello", status: 200 },
  structure: { title: "A", headings: [], buttons: [], labels: [], hasNav: true },
  httpStatus: 200,
  finalPath: "/a",
  settled: true,
  blockedWrites: [],
  ...over,
});
const session = (pages: PageEvidence[], probes: (string[] | undefined)[] = []) => {
  let i = 0;
  return { visit: async (_p: string, _d?: string, _n?: string, o?: { selectors?: string[] }) => (probes.push(o?.selectors), pages[Math.min(i++, pages.length - 1)]!) } as unknown as QaSession;
};
function judge(requests: string[], answers: Record<string, unknown>) {
  const fetch = async (_u: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(Object.keys(body.questions)[0]!);
    const out = "severity" in body.questions ? { severity: { type: "score", score: 4, confidence: 0.9, legend: {}, probabilities: {} } } : answers;
    return new Response(JSON.stringify({ model: "m", answers: out, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return new Judge({ apiKey: "k", fetch });
}
const sel = (id: string, pinned = false) => a(id, "llm-author", pinned, { kind: "selector-visible", value: `#${id}` });
const opts = { retryCount: 2, evidenceDir: "/tmp/x" };

test("a deterministic assertion that held at baseline and fails at head is a stable expectation finding; the probe carries its selector", async () => {
  const reqs: string[] = [];
  const probes: (string[] | undefined)[] = [];
  const node = nodeWith([sel("gone"), sel("never-held"), sel("new")], { gone: "holds", "never-held": "fails" });
  const r = await checkFlow(session([ev({ selectors: { "#gone": false, "#never-held": false, "#new": false } })], probes), node, "/a", judge(reqs, {}), opts);
  assert.deepEqual(probes[0], ["#gone", "#never-held"], "the baseline's set is probed; one with no baseline state is not");
  assert.deepEqual(r.comparison, { compared: 1, skippedNoBaseline: 1 });
  assert.equal(r.findings.length, 1);
  const f = r.findings[0]!;
  assert.deepEqual([f.kind, f.assertionId, f.pinned, f.confidence], ["expectation", "gone", false, "stable"]);
  assert.equal(r.status, "failed");
  assert.equal(r.attempts, 3, "re-evaluated on every retry");
  assert.equal(r.checksRun, 5);
  assert.ok(reqs.every((q) => q === "severity"), "no Jev assertion request for deterministic checks");
});

test("a Jev-only failure of an unpinned assertion is never stable; pinned follows the normal rules", async () => {
  const fails = { a0: { type: "choice", choice: "fails", confidence: 0.9, probabilities: {} } };
  for (const [pinned, expected] of [[false, "maybe"], [true, "stable"]] as const) {
    const node = nodeWith([a("j", "llm-author", pinned, { kind: "custom", value: "x" })], { j: "holds" });
    const r = await checkFlow(session([ev()]), node, "/a", judge([], fails), opts);
    assert.equal(r.findings[0]!.confidence, expected, `pinned=${pinned}`);
    assert.equal(r.status, expected === "stable" ? "failed" : "maybe");
  }
});

test("assertions that held at head, or have no baseline state, produce nothing and cost no Jev", async () => {
  const reqs: string[] = [];
  const node = nodeWith([sel("ok"), a("j", "llm-author", false, { kind: "custom", value: "x" })], { ok: "holds" });
  const r = await checkFlow(session([ev({ selectors: { "#ok": true } })]), node, "/a", judge(reqs, {}), opts);
  assert.equal(r.status, "passed");
  assert.deepEqual(r.comparison, { compared: 1, skippedNoBaseline: 1 });
  assert.equal(reqs.length, 0);
});

test("an unchanged page replays the baseline's Jev answers from cache: zero requests, zero findings", async () => {
  const { JevCache } = await import("../jev/cache.js");
  const { evaluateAssertions, planComparison, toFingerprints, toStates } = await import("../compare/compare.js");
  const prose = [a("p1", "llm-author", false, { kind: "custom", value: "x" }), a("p2", "llm-author", true, { kind: "custom", value: "y" }), sel("s")];
  const page = ev({ selectors: { "#s": true } });
  const holds = { a0: { type: "choice", choice: "holds", confidence: 0.9, probabilities: {} }, a1: { type: "choice", choice: "holds", confidence: 0.9, probabilities: {} } };
  const cache = new JevCache<{ choice: string; confidence: number }[]>(null, "m");
  // baseline: one batched request for the two prose assertions
  const baseReqs: string[] = [];
  const base = await evaluateAssertions(judge(baseReqs, holds), nodeWith(prose), prose, page, cache);
  assert.equal(baseReqs.length, 1);
  const node = nodeWith(prose, toStates(base));
  node.observed = { ...node.observed!, assertionFingerprints: toFingerprints(prose) };
  assert.equal(planComparison(node).armed.length, 3);
  // head, same page: the same question, answered from cache
  const headReqs: string[] = [];
  const r = await checkFlow(session([page]), node, "/a", judge(headReqs, {}), { ...opts, caches: { assertions: cache } });
  assert.equal(headReqs.length, 0);
  assert.equal(r.findings.length, 0);
});

test("a baseline state recorded for different text is not reused under the same id", async () => {
  const { planComparison, toFingerprints } = await import("../compare/compare.js");
  const old = sel("x");
  const node = nodeWith([{ ...old, expectation: "re-enriched: a different claim" }], { x: "holds" });
  node.observed = { ...node.observed!, assertionFingerprints: toFingerprints([old]) };
  const p = planComparison(node);
  assert.equal(p.armed.length, 0);
  assert.equal(p.skippedNoBaseline, 1);
});

test("a qa-observed assertion is checked by the old path only, never also by the comparator", async () => {
  const node = nodeWith([a("Gone", "qa-observed")], { Gone: "holds" });
  const reqs: string[] = [];
  const r = await checkFlow(session([ev()]), node, "/a", judge(reqs, { evidence_sufficient: { type: "noul", noul: 0.9 }, expectation_holds: { type: "noul", noul: 0.05 } }), { ...opts, retryCount: 0 });
  assert.deepEqual(r.findings.map((f) => f.kind), ["assertion"]);
  assert.equal(r.comparison?.compared, 0);
});
