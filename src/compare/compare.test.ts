import { test } from "node:test";
import assert from "node:assert/strict";
import { Judge } from "../jev/client.js";
import { JevCache } from "../jev/cache.js";
import type { Assertion, FlowNode } from "../mindmap/schema.js";
import type { PageEvidence } from "../qa/driver.js";
import { comparable, decideByCheck, evaluateAssertions, failureText, planComparison, probeSelectors, regressed, urlMatches, type AssertionCache } from "./compare.js";

const asrt = (id: string, check?: Assertion["check"], origin: Assertion["provenance"]["origin"] = "llm-author", pinned = false): Assertion => ({
  id,
  expectation: `expect ${id}`,
  check,
  severityIfBroken: 3,
  pinned,
  provenance: { sourceFiles: [], origin, confidence: 0.5 },
});
const node = (assertions: Assertion[], assertionStates?: Record<string, "holds" | "fails" | "unobservable">): FlowNode => ({
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
});
const evidence = (over: Partial<PageEvidence> = {}): PageEvidence => ({
  observation: { url: "/a", text: "Welcome back Sign in", status: 200 },
  structure: { title: "A", headings: ["Welcome back"], buttons: ["Sign in"], labels: ["Email"], hasNav: true },
  httpStatus: 200,
  finalPath: "/a",
  settled: true,
  blockedWrites: [],
  ...over,
});

function fakeJudge(answers: (state: any, questions: any) => Record<string, unknown>, calls: any[]) {
  const fetch = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    return new Response(JSON.stringify({ model: "jev-test", answers: answers(body.state, body.questions), usage: { input_tokens: 10, output_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return new Judge({ apiKey: "k", fetch });
}
const choiceA = (c: string, confidence = 0.9) => ({ type: "choice", choice: c, confidence, probabilities: {} });

test("selector-visible comes from the probe; invalid or unprobed selectors are unobservable", () => {
  const sel = (v: string) => asrt("s", { kind: "selector-visible", value: v });
  const ev = evidence({ selectors: { "#a": true, "#b": false, "[": "invalid" } });
  assert.equal(decideByCheck(sel("#a"), ev), "holds");
  assert.equal(decideByCheck(sel("#b"), ev), "fails");
  assert.equal(decideByCheck(sel("["), ev), "unobservable");
  assert.equal(decideByCheck(sel("#never-probed"), ev), "unobservable");
});

test("text-present, status-ok and uncheckable assertions", () => {
  const ev = evidence();
  assert.equal(decideByCheck(asrt("t", { kind: "text-present", value: "Sign in" }), ev), "holds");
  assert.equal(decideByCheck(asrt("t", { kind: "text-present", value: "Email" }), ev), "holds"); // label
  assert.equal(decideByCheck(asrt("t", { kind: "text-present", value: "Sign out" }), ev), "fails");
  assert.equal(decideByCheck(asrt("s", { kind: "status-ok", value: "<400" }), ev), "holds");
  assert.equal(decideByCheck(asrt("s", { kind: "status-ok", value: "<400" }), evidence({ httpStatus: 500 })), "fails");
  assert.equal(decideByCheck(asrt("s", { kind: "status-ok", value: "<400" }), evidence({ httpStatus: undefined })), "unobservable");
  assert.equal(decideByCheck(asrt("n"), ev), undefined);
  assert.equal(decideByCheck(asrt("c", { kind: "custom", value: "x" }), ev), undefined);
});

test("url-matches: exact path with a leading slash; ends-with on a segment boundary without one", () => {
  assert.ok(urlMatches("/login", "/login"));
  assert.ok(urlMatches("/login", "/login/"));
  assert.ok(!urlMatches("/login", "/login/extra"));
  assert.ok(!urlMatches("/login", "/auth/login"));
  assert.ok(urlMatches("login", "/auth/login"));
  assert.ok(urlMatches("login", "/login"));
  assert.ok(!urlMatches("login", "/relogin"));
  assert.ok(urlMatches("/book/:id", "/book/42"));
  assert.ok(!urlMatches("/book/:id", "/book/42/edit"));
  assert.ok(urlMatches("/collection/*", "/collection/a/b"));
  assert.ok(urlMatches("^/home$", "/home"));
  assert.ok(urlMatches("https://x.test/home?x=1#y", "/home"));
  assert.ok(!urlMatches("/a.b", "/axb"));
});

test("only llm-author and human assertions are comparable; qa-observed keeps its own path", () => {
  const n = node([asrt("o", undefined, "qa-observed"), asrt("l"), asrt("h", undefined, "human", true)]);
  assert.deepEqual(comparable(n).map((a) => a.id), ["l", "h"]);
});

test("probeSelectors collects distinct selector-visible values only", () => {
  const as = [asrt("1", { kind: "selector-visible", value: "#a" }), asrt("2", { kind: "selector-visible", value: "#a" }), asrt("3", { kind: "text-present", value: "#b" })];
  assert.deepEqual(probeSelectors(as), ["#a"]);
});

test("deterministic assertions never reach Jev: no request at all", async () => {
  const calls: any[] = [];
  const judge = fakeJudge(() => ({}), calls);
  const as = [asrt("1", { kind: "text-present", value: "Sign in" }), asrt("2", { kind: "selector-visible", value: "#x" })];
  const out = await evaluateAssertions(judge, node(as), as, evidence({ selectors: { "#x": false } }));
  assert.deepEqual(out.map((e) => [e.id, e.state, e.decidedBy]), [["1", "holds", "check"], ["2", "fails", "check"]]);
  assert.equal(calls.length, 0);
});

test("Jev: one batched request for the undecided ones, low confidence is unobservable, long text truncated", async () => {
  const calls: any[] = [];
  const judge = fakeJudge(
    () => ({ a0: choiceA("holds"), a1: choiceA("fails", 0.4), a2: choiceA("fails", 0.95), a3: choiceA("unobservable") }),
    calls,
  );
  const as = [asrt("1"), asrt("2", { kind: "custom", value: "x" }), asrt("3"), asrt("4"), asrt("det", { kind: "text-present", value: "Sign in" })];
  const long = evidence({ observation: { url: "/a", text: "x".repeat(9000) } });
  const out = await evaluateAssertions(judge, node(as), as, { ...long, structure: { ...long.structure, buttons: ["Sign in"] } });
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].questions), ["a0", "a1", "a2", "a3"]);
  assert.deepEqual(calls[0].state.expectations, ["expect 1", "expect 2", "expect 3", "expect 4"]);
  assert.equal(calls[0].state.page.text.length, 6000);
  assert.deepEqual(calls[0].questions.a0.criteria && Object.keys(calls[0].questions.a0.criteria), ["holds", "fails", "unobservable"]);
  assert.deepEqual(out.map((e) => e.state), ["holds", "unobservable", "fails", "unobservable", "holds"]);
});

test("Jev requests are chunked at 40 and cached by question set + exact state", async () => {
  const calls: any[] = [];
  const judge = fakeJudge((_s, q) => Object.fromEntries(Object.keys(q).map((k) => [k, choiceA("holds")])), calls);
  const as = Array.from({ length: 45 }, (_, i) => asrt(`n${i}`));
  const cache: AssertionCache = new JevCache(null, "m");
  const n = node(as);
  const out = await evaluateAssertions(judge, n, as, evidence(), cache);
  assert.equal(out.length, 45);
  assert.deepEqual(calls.map((c) => Object.keys(c.questions).length), [40, 5]);
  await evaluateAssertions(judge, n, as, evidence(), cache);
  assert.equal(calls.length, 2, "identical page state is answered from the cache");
  await evaluateAssertions(judge, n, as, evidence({ observation: { url: "/a", text: "changed" } }), cache);
  assert.equal(calls.length, 4);
});

test("planComparison arms only what held at baseline; no state is skipped, not guessed", () => {
  const as = [asrt("held"), asrt("failed"), asrt("unobs"), asrt("new"), asrt("obs", undefined, "qa-observed")];
  const n = node(as, { held: "holds", failed: "fails", unobs: "unobservable" });
  const p = planComparison(n);
  assert.deepEqual(p.armed.map((a) => a.id), ["held"]);
  assert.equal(p.skippedNoBaseline, 1);
  assert.equal(p.notHeldAtBaseline, 2);
  assert.deepEqual(planComparison(node(as)).armed, []);
});

test("regressed: only armed assertions failing at head; unobservable at head is not a regression", () => {
  const a = asrt("a");
  const b = asrt("b");
  const r = regressed(
    [a, b],
    [
      { id: "a", state: "fails", decidedBy: "jev" },
      { id: "b", state: "unobservable", decidedBy: "check" },
      { id: "c", state: "fails", decidedBy: "check" },
    ],
  );
  assert.deepEqual(r.map((x) => [x.assertion.id, x.decidedBy]), [["a", "jev"]]);
  assert.match(failureText(asrt("s", { kind: "selector-visible", value: "#x" }), "check"), /#x is not visible/);
});
