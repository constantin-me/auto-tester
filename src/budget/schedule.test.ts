import { test } from "node:test";
import assert from "node:assert/strict";
import { bestFirst, visitCost } from "./schedule.js";
import type { Assertion, FlowNode } from "../mindmap/schema.js";

const a = (id: string, check?: Assertion["check"]): Assertion => ({
  id,
  expectation: id,
  ...(check ? { check } : {}),
  severityIfBroken: 3,
  pinned: false,
  provenance: { sourceFiles: [], origin: "llm-author", confidence: 0.8 },
});

const node = (id: string, assertions: Assertion[] = [], held: string[] = []): FlowNode => ({
  id,
  label: id,
  route: `/${id}`,
  views: [],
  kind: "page",
  requiresAuth: false,
  guards: [],
  assertions,
  provenance: { sourceFiles: [], origin: "static-crawl", confidence: 0.5 },
  observed: { at: "t", status: "reachable", assertionStates: Object.fromEntries(held.map((h) => [h, "holds" as const])) },
});

test("visitCost: only baseline-held assertions without a machine check cost a Jev request, batched by 40", () => {
  assert.equal(visitCost(node("plain")), 1);
  const sel = a("sel", { kind: "selector-visible", value: "#x" });
  assert.equal(visitCost(node("checks-only", [sel], ["sel"])), 1);
  const prose = Array.from({ length: 41 }, (_, i) => a(`p${i}`));
  // 41 held prose assertions -> 2 batched requests; ones that did not hold at baseline cost nothing
  assert.equal(visitCost(node("prose", prose, prose.map((p) => p.id))), 3);
  assert.equal(visitCost(node("not-held", prose)), 1);
});

test("bestFirst: value per cost, ties keep their order", () => {
  const prose = Array.from({ length: 3 }, (_, i) => a(`p${i}`));
  const items = [
    { n: node("costly", prose, prose.map((p) => p.id)), v: 2 }, // 2 / 2 = 1
    { n: node("cheap"), v: 1.5 }, //                               1.5 / 1 = 1.5
    { n: node("tie-a"), v: 1 },
    { n: node("tie-b"), v: 1 },
  ];
  const order = bestFirst(items, (x) => x.v, (x) => x.n).map((x) => x.n.id);
  assert.deepEqual(order, ["cheap", "costly", "tie-a", "tie-b"]);
});
