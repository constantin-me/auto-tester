import { test } from "node:test";
import assert from "node:assert/strict";
import { Judge, mapLimit, type UsageRecord } from "./client.js";
import { triageFlow, judgeObservation, rateSeverity, chooseNextAction, pickModelTier, type FlowContext } from "./judgments.js";

/**
 * Offline wiring tests: a fake transport stands in for api.typesafe.ai.
 * They verify what we SEND (state, question ids/types) and how we MAP answers
 * through policy — not model quality, which needs live runs.
 */

type Answers = Record<string, unknown>;

function fakeJudge(answers: Answers, seen: { body?: any; usage: UsageRecord[] }) {
  const fetch = async (_url: string, init?: RequestInit) => {
    seen.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 120, output_tokens: 4 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return new Judge({ apiKey: "test-key", fetch, onUsage: (u) => seen.usage.push(u) });
}

const noulA = (p: number) => ({ type: "noul", noul: p });
const scoreA = (s: number, confidence = 0.9) => ({ type: "score", score: s, confidence, legend: {}, probabilities: {} });
const choiceA = (c: string, confidence = 0.9) => ({ type: "choice", choice: c, confidence, probabilities: {} });

const flow: FlowContext = {
  node: {
    id: "node:book-id",
    label: "Book {id}",
    route: "/book/:id",
    view: "detail",
    kind: "page",
    requiresAuth: true,
    guards: ["requireAuthOrShareView"],
    assertions: [],
    provenance: { sourceFiles: ["core/routes/itemRoutes.ts"], origin: "static-crawl", confidence: 0.4 },
  },
  edges: [
    {
      id: "e1",
      from: "node:book-id",
      to: "node:book-id",
      kind: "api",
      action: "fetch DELETE /api/book/:id",
      assertions: [],
      provenance: { sourceFiles: [], origin: "static-crawl", confidence: 0.5 },
    },
  ],
};
const change = { summary: "fix(routes): answer 404", files: [{ path: "core/routes/itemRoutes.ts", patch: "x".repeat(5000) }] };

test("triage sends one request with five atomic questions and flow/change state", async () => {
  const seen: { body?: any; usage: UsageRecord[] } = { usage: [] };
  const judge = fakeJudge(
    { runs_changed_code: noulA(0.92), alters_user_behavior: noulA(0.8), impact: scoreA(2.4), behavior_preserving: noulA(0.1), criticality: scoreA(2) },
    seen,
  );
  const t = await triageFlow(judge, change, flow);

  assert.deepEqual(Object.keys(seen.body.questions).sort(), ["alters_user_behavior", "behavior_preserving", "criticality", "impact", "runs_changed_code"]);
  assert.equal(seen.body.questions.runs_changed_code.type, "noul");
  assert.deepEqual(Object.keys(seen.body.questions.runs_changed_code.criteria).sort(), ["false", "true"]);
  assert.equal(seen.body.questions.impact.criteria.length, 4);
  assert.equal(seen.body.state.flow.route, "/book/:id");
  assert.ok(seen.body.state.change.files[0].patch.endsWith("…(truncated)"), "large patches are truncated");

  assert.equal(t.affected, true);
  assert.equal(t.escalate, false);
  assert.ok(t.value > 0.6 && t.value <= 1);
  assert.deepEqual(seen.usage, [{ purpose: "triage", model: "jev-test", inputTokens: 120, outputTokens: 4 }]);
});

test("triage: code does not run -> not affected, even with high impact", async () => {
  const judge = fakeJudge(
    { runs_changed_code: noulA(0.1), alters_user_behavior: noulA(0.9), impact: scoreA(3), behavior_preserving: noulA(0.1), criticality: scoreA(3) },
    { usage: [] },
  );
  const t = await triageFlow(judge, change, flow);
  assert.equal(t.affected, false);
});

test("triage: uncertain P(runs) escalates", async () => {
  const judge = fakeJudge(
    { runs_changed_code: noulA(0.5), alters_user_behavior: noulA(0.5), impact: scoreA(1), behavior_preserving: noulA(0.1), criticality: scoreA(1) },
    { usage: [] },
  );
  assert.equal((await triageFlow(judge, change, flow)).escalate, true);
});

test("triage: a confident pure refactor is not affected", async () => {
  const judge = fakeJudge(
    { runs_changed_code: noulA(0.9), alters_user_behavior: noulA(0.6), impact: scoreA(2), behavior_preserving: noulA(0.85), criticality: scoreA(2) },
    { usage: [] },
  );
  const t = await triageFlow(judge, change, flow);
  assert.equal(t.affected, false);
  assert.equal(t.pPreserving, 0.85);
});

test("triage with focus sends reasons and hunks instead of whole files", async () => {
  const seen: { body?: any; usage: UsageRecord[] } = { usage: [] };
  const judge = fakeJudge(
    { runs_changed_code: noulA(0.9), alters_user_behavior: noulA(0.9), impact: scoreA(2), behavior_preserving: noulA(0.1), criticality: scoreA(2) },
    seen,
  );
  await triageFlow(judge, change, flow, undefined, { reasons: ["handler of GET /book/:id changed"], hunks: ["@@ -1 +1 @@\n-a\n+b"] });
  assert.deepEqual(seen.body.state.change.why_this_flow, ["handler of GET /book/:id changed"]);
  assert.deepEqual(seen.body.state.change.all_changed_files, ["core/routes/itemRoutes.ts"]);
  assert.equal(seen.body.state.change.files, undefined);
});

test("observation verdicts: insufficient evidence wins over holds", async () => {
  const obs = { url: "http://x/book/1", text: "Loading…" };
  const cases: [number, number, string][] = [
    [0.2, 0.95, "inconclusive"],
    [0.9, 0.95, "match"],
    [0.9, 0.1, "deviation"],
    [0.9, 0.5, "inconclusive"],
  ];
  for (const [sufficient, holds, expected] of cases) {
    const judge = fakeJudge({ evidence_sufficient: noulA(sufficient), expectation_holds: noulA(holds) }, { usage: [] });
    assert.equal((await judgeObservation(judge, "Shows the book title", obs)).verdict, expected, `${sufficient}/${holds}`);
  }
});

test("severity sends the 6-level 0–5 rubric and rounds the level", async () => {
  const seen: { body?: any; usage: UsageRecord[] } = { usage: [] };
  const judge = fakeJudge({ severity: scoreA(3.6, 0.7) }, seen);
  const s = await rateSeverity(judge, { flow: "Book detail", expectation: "loads", actual: "500 error" });
  assert.equal(seen.body.questions.severity.criteria.length, 6);
  assert.equal(s.level, 4);
});

test("next action: candidates become choice labels plus a none option", async () => {
  const seen: { body?: any; usage: UsageRecord[] } = { usage: [] };
  const judge = fakeJudge({ next_action: choiceA("none_of_these", 0.3), goal_reached: noulA(0.1) }, seen);
  const r = await chooseNextAction(judge, "Open the collection", { url: "http://x/", text: "Home" }, [
    { id: "a0", description: "click link 'Collection' -> /collection" },
  ]);
  assert.deepEqual(Object.keys(seen.body.questions.next_action.criteria), ["a0", "none_of_these"]);
  assert.equal(r.actionId, null);
  assert.equal(r.escalate, true);
});

test("model tier: cheap only when confidently cheap", async () => {
  const unsure = fakeJudge({ tier: choiceA("cheap", 0.4) }, { usage: [] });
  assert.equal((await pickModelTier(unsure, "check a title")).tier, "expensive");
  const sure = fakeJudge({ tier: choiceA("cheap", 0.9) }, { usage: [] });
  assert.equal((await pickModelTier(sure, "check a title")).tier, "cheap");
});

test("mapLimit keeps order and caps concurrency", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, n));
    inFlight--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 30, 20, 40]);
  assert.equal(peak, 2);
});

test("missing key gives an actionable error", () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    assert.throws(() => new Judge(), /TYPESAFE_API_KEY is not set/);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});
