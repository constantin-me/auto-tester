import { test } from "node:test";
import assert from "node:assert/strict";
import { hasCriteria, listAssertions, setPinned, setPinnedByFilter } from "./pin.js";
import type { Assertion, MindMap } from "./schema.js";

const a = (id: string, origin: Assertion["provenance"]["origin"], severity = 3, pinned = false, expectation = id): Assertion => ({
  id,
  expectation,
  severityIfBroken: severity,
  pinned,
  provenance: { sourceFiles: [], origin, confidence: 0.7 },
});
const prov = { sourceFiles: [], origin: "static-crawl" as const, confidence: 0.5 };
const map = (): MindMap => ({
  schemaVersion: 1,
  repo: "r",
  generatedAt: "t",
  nodes: [
    { id: "node:login", label: "Login", views: [], kind: "page", requiresAuth: false, guards: [], provenance: prov, assertions: [
      a("l1", "llm-author", 5, false, "Shows the Login form"),
      a("l2", "llm-author", 4),
      a("l3", "llm-author", 2),
      a("h1", "human", 5, true),
    ] },
    { id: "node:add-record", label: "Add", views: [], kind: "page", requiresAuth: true, guards: [], provenance: prov, assertions: [a("r1", "llm-author", 4)] },
    { id: "node:add-label", label: "Add L", views: [], kind: "page", requiresAuth: true, guards: [], provenance: prov, assertions: [a("x1", "qa-observed", 1)] },
  ],
  edges: [{ id: "edge:login-submit", from: "node:login", to: "node:add-record", action: "submit", kind: "submit", assertions: [a("e1", "llm-author", 4)], provenance: prov }],
});

test("list filters by exact node, glob, origin, pinned, severity, grep", () => {
  const m = map();
  assert.deepEqual(listAssertions(m, { nodes: ["node:login"] }).map((r) => r.assertion.id), ["l1", "l2", "l3", "h1"]);
  assert.deepEqual(listAssertions(m, { nodes: ["node:add-*"] }).map((r) => r.assertion.id), ["r1", "x1"]);
  assert.deepEqual(listAssertions(m, { origin: "human" }).map((r) => r.assertion.id), ["h1"]);
  assert.deepEqual(listAssertions(m, { pinned: false, nodes: ["node:login"], minSeverity: 4 }).map((r) => r.assertion.id), ["l1", "l2"]);
  assert.deepEqual(listAssertions(m, { grep: "LOGIN FORM" }).map((r) => r.assertion.id), ["l1"]);
  assert.equal(listAssertions(m).length, 7);
});

test("list covers edge assertions", () => {
  const rows = listAssertions(map(), { nodes: ["edge:*"] });
  assert.deepEqual(rows.map((r) => [r.ownerKind, r.assertion.id]), [["edge", "e1"]]);
});

test("pin sets pinned and confidence 1, keeps origin, reports states, does not mutate input", () => {
  const m = map();
  const { map: out, report } = setPinned(m, ["l1", "h1", "e1", "nope"], true);
  assert.deepEqual(report, { changed: ["l1", "e1"], alreadyInState: ["h1"], notFound: ["nope"] });
  const l1 = out.nodes[0]!.assertions[0]!;
  assert.equal(l1.pinned, true);
  assert.equal(l1.provenance.confidence, 1);
  assert.equal(l1.provenance.origin, "llm-author");
  assert.equal(out.edges[0]!.assertions[0]!.pinned, true);
  assert.equal(m.nodes[0]!.assertions[0]!.pinned, false);
  // everything else untouched (same references)
  assert.equal(out.nodes[0]!.assertions[1], m.nodes[0]!.assertions[1]);
  assert.equal(out.nodes[1], m.nodes[1]);
});

test("unpin restores 0.9 for llm-author, keeps confidence otherwise", () => {
  const { map: pinned } = setPinned(map(), ["l1"], true);
  const { map: out, report } = setPinned(pinned, ["l1", "l2"], false);
  assert.deepEqual(report, { changed: ["l1"], alreadyInState: ["l2"], notFound: [] });
  assert.equal(out.nodes[0]!.assertions[0]!.provenance.confidence, 0.9);
  const hm = map();
  const { map: out2 } = setPinned(hm, ["h1"], false);
  assert.equal(out2.nodes[0]!.assertions[3]!.pinned, false);
  assert.equal(out2.nodes[0]!.assertions[3]!.provenance.confidence, 0.7);
});

test("bulk pin by filter, and refusal of an empty filter", () => {
  const { map: out, report } = setPinnedByFilter(map(), { nodes: ["node:login"], minSeverity: 4 }, true);
  assert.deepEqual(report.changed, ["l1", "l2"]);
  assert.deepEqual(report.alreadyInState, ["h1"]);
  assert.equal(out.nodes[0]!.assertions[2]!.pinned, false);
  assert.equal(hasCriteria({}), false);
  // --unpinned alone still means "everything not yet pinned": not a narrowing filter
  assert.equal(hasCriteria({ pinned: false }), false);
  assert.throws(() => setPinnedByFilter(map(), {}, true), /at least one filter/);
  assert.throws(() => setPinnedByFilter(map(), { pinned: false }, true), /at least one filter/);
});
