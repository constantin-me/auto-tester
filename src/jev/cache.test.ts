import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JevCache } from "./cache.js";

test("same question + state + model is asked once and persisted; any change re-asks", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "jc-")), "c.json");
  let asked = 0;
  const ask = async () => ++asked;
  const a = new JevCache<number>(file, "jev-1");
  assert.equal(await a.getOrAsk(a.key("triage", { q: 1 }, { s: 1 }), ask), 1);
  assert.equal(await a.getOrAsk(a.key("triage", { q: 1 }, { s: 1 }), ask), 1);
  a.save();

  const b = new JevCache<number>(file, "jev-1");
  assert.equal(await b.getOrAsk(b.key("triage", { q: 1 }, { s: 1 }), ask), 1, "persisted across runs");
  assert.equal(await b.getOrAsk(b.key("triage", { q: 1 }, { s: 2 }), ask), 2, "different state");
  assert.equal(await b.getOrAsk(b.key("triage", { q: 2 }, { s: 1 }), ask), 3, "different question set");
  const c = new JevCache<number>(file, "jev-2");
  assert.equal(await c.getOrAsk(c.key("triage", { q: 1 }, { s: 1 }), ask), 4, "different model");
  assert.equal(b.hits, 1);
  assert.equal(b.misses, 2);
});

test("a null file keeps answers for the run only", async () => {
  const c = new JevCache<number>(null, "m");
  let asked = 0;
  await c.getOrAsk("k", async () => ++asked);
  await c.getOrAsk("k", async () => ++asked);
  c.save();
  assert.equal(asked, 1);
});

test("a finding re-judged on a second run asks Jev nothing (observation + severity cached)", async () => {
  const { Judge } = await import("./client.js");
  const { judgeObservation, rateSeverity } = await import("./judgments.js");
  const file = (n: string) => join(mkdtempSync(join(tmpdir(), "jc-")), n);
  const obsFile = file("o.json");
  const sevFile = file("s.json");
  let requests = 0;
  const fetch = async (_: string, init?: RequestInit) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    const answers = "severity" in body.questions
      ? { severity: { type: "score", score: 3.4, confidence: 0.8, legend: {}, probabilities: {} } }
      : { evidence_sufficient: { type: "noul", noul: 0.9 }, expectation_holds: { type: "noul", noul: 0.1 } };
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const judge = new Judge({ apiKey: "k", fetch });
  const obs = { url: "/search", text: "Internal error" };
  const finding = { flow: "Search (/search)", expectation: "loads", actual: "HTTP 500" };

  for (let run = 1; run <= 2; run++) {
    const oc = new JevCache<{ pSufficient: number; pHolds: number }>(obsFile, "jev-1.13.0");
    const sc = new JevCache<{ score: number; confidence: number }>(sevFile, "jev-1.13.0");
    const j = await judgeObservation(judge, "Shows search results", obs, undefined, oc);
    const s = await rateSeverity(judge, finding, sc);
    assert.equal(j.verdict, "deviation");
    assert.equal(s.level, 3);
    oc.save();
    sc.save();
  }
  assert.equal(requests, 2, "run 1 asks twice, run 2 asks nothing");
});
