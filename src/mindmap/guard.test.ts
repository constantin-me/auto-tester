import { test } from "node:test";
import assert from "node:assert/strict";
import { carryEnrichment, carryObservations, mergePreservingPins } from "./guard.js";
import type { Assertion, FlowNode, MindMap } from "./schema.js";

const assertion = (id: string, origin: Assertion["provenance"]["origin"], pinned = false): Assertion => ({
  id,
  expectation: id,
  severityIfBroken: 3,
  pinned,
  provenance: { sourceFiles: [], origin, confidence: 0.5 },
});
const node = (id: string, label: string, assertions: Assertion[] = []): FlowNode => ({
  id,
  label,
  route: "/x",
  views: [],
  kind: "page",
  requiresAuth: false,
  guards: [],
  assertions,
  provenance: { sourceFiles: [], origin: "static-crawl", confidence: 0.5 },
});
const map = (nodes: FlowNode[]): MindMap => ({ schemaVersion: 1, repo: "r", generatedAt: "t", nodes, edges: [] });

/** the bootstrap merge, as in src/cli/bootstrap.ts */
const recrawl = (previous: MindMap, fresh: MindMap) => carryEnrichment(previous, carryObservations(previous, mergePreservingPins(previous, fresh)));

test("re-crawl keeps enrichment: llm-author assertions and the enriched label survive", () => {
  const previous = map([
    node("node:a", "Collection dashboard", [
      assertion("llm:node:a:shows-grid", "llm-author"),
      assertion("pin", "human", true),
      assertion("qa:a", "qa-observed"),
    ]),
    node("node:gone", "Gone", [assertion("llm:node:gone:x", "llm-author")]),
  ]);
  const fresh = map([node("node:a", "A"), node("node:b", "B")]);
  const out = recrawl(previous, fresh);
  const a = out.nodes.find((n) => n.id === "node:a")!;
  assert.equal(a.label, "Collection dashboard");
  assert.deepEqual(a.assertions.map((x) => x.id).sort(), ["llm:node:a:shows-grid", "pin", "qa:a"]);
  // each id once
  assert.equal(new Set(a.assertions.map((x) => x.id)).size, a.assertions.length);
  // a node that is new keeps the crawler's label; a deleted node is not resurrected
  assert.equal(out.nodes.find((n) => n.id === "node:b")!.label, "B");
  assert.equal(out.nodes.some((n) => n.id === "node:gone"), false);
});

test("re-crawl of a never-enriched node keeps the crawler's label", () => {
  const out = recrawl(map([node("node:a", "Old crawler label")]), map([node("node:a", "New crawler label")]));
  assert.equal(out.nodes[0]!.label, "New crawler label");
});
