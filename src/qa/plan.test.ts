import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, globalTexts, observedAssertions, planVisits, resolvePath, withObserved } from "./plan.js";
import { expandEnv, type PageEvidence } from "./driver.js";
import type { FlowNode } from "../mindmap/schema.js";

const node = (id: string, route: string, kind: FlowNode["kind"] = "page"): FlowNode => ({
  id,
  label: id,
  route,
  view: undefined,
  views: [],
  kind,
  requiresAuth: true,
  guards: [],
  assertions: [],
  provenance: { sourceFiles: ["x.ts"], origin: "static-crawl", confidence: 0.6 },
});

const evidence = (over: Partial<PageEvidence> = {}): PageEvidence => ({
  observation: { url: "/collection", text: "" },
  structure: { title: "t", headings: [], buttons: [], labels: [], hasNav: true },
  httpStatus: 200,
  finalPath: "/collection",
  settled: true,
  blockedWrites: [],
  ...over,
});

test("resolvePath: static routes as-is, params from live links, none when nothing matches", () => {
  const links = ["/", "/album/6ab8006b372c2aa1592cd4e5", "/collection"];
  assert.equal(resolvePath("/collection", links), "/collection");
  assert.equal(resolvePath("/album/:id", links), "/album/6ab8006b372c2aa1592cd4e5");
  assert.equal(resolvePath("/book/:id", links), undefined);
});

test("planVisits: endpoints, deny list and missing data are explicit statuses", () => {
  const plan = planVisits(
    [node("n:c", "/collection"), node("n:e", "/backup/export", "endpoint"), node("n:l", "/logout"), node("n:b", "/book/:id")],
    ["/collection"],
    { denyPaths: ["/logout"], visitEndpoints: false },
  );
  assert.deepEqual(
    plan.map((p) => [p.node.id, p.path ?? p.status]),
    [
      ["n:c", "/collection"],
      ["n:e", "skipped"],
      ["n:l", "skipped"],
      ["n:b", "untestable-no-data"],
    ],
  );
});

test("classify: 404 is unreachable here, not a failure; a redirect to login is recorded, not session loss", () => {
  assert.equal(classify(evidence({ httpStatus: 404 }), "/login", "/add-books").status, "unreachable-here");
  assert.equal(classify(evidence({ httpStatus: 500 }), "/login", "/x").status, "failed");
  const r = classify(evidence({ finalPath: "/login" }), "/login", "/setup");
  assert.equal(r.status, "ok");
  assert.match(r.reason, /redirects to the login page/);
});

test("globalTexts: shared chrome is text present on most pages (at least 3)", () => {
  const t = (s: string) => ({ kind: "control" as const, text: s });
  const pages = [[t("Create"), t("A")], [t("Create"), t("B")], [t("Create")], [t("C")]];
  assert.deepEqual([...globalTexts(pages)], ["Create"]);
});

test("observedAssertions: a redirect becomes one url-matches assertion; texts become text-present", () => {
  const n = node("n:s", "/setup");
  const redirect = observedAssertions(n, evidence({ finalPath: "/login" }), "/setup", []);
  assert.deepEqual(redirect.map((a) => [a.check?.kind, a.check?.value]), [["url-matches", "/login"]]);
  const page = observedAssertions(node("n:c", "/collection"), evidence(), "/collection", [{ kind: "control", text: "Sort by" }]);
  assert.deepEqual(page.map((a) => a.check?.kind), ["status-ok", "text-present"]);
  assert.ok(page.every((a) => a.provenance.origin === "qa-observed" && !a.pinned));
});

test("withObserved replaces qa-observed assertions but keeps pinned and authored ones", () => {
  const n = node("n:c", "/collection");
  n.assertions = [
    { id: "old", expectation: "old", severityIfBroken: 2, pinned: false, provenance: { sourceFiles: [], origin: "qa-observed", confidence: 0.7 } },
    { id: "pin", expectation: "human", severityIfBroken: 5, pinned: true, provenance: { sourceFiles: [], origin: "human", confidence: 1 } },
  ];
  const fresh = observedAssertions(n, evidence(), "/collection", []);
  assert.deepEqual(withObserved(n, fresh).assertions.map((a) => a.id).sort(), ["pin", fresh[0]!.id].sort());
});

test("expandEnv names a missing variable without revealing values", () => {
  process.env.QA_TEST_SECRET = "s3cret";
  assert.equal(expandEnv("${QA_TEST_SECRET}"), "s3cret");
  assert.throws(() => expandEnv("${QA_TEST_MISSING}"), /QA_TEST_MISSING is not set/);
  delete process.env.QA_TEST_SECRET;
});
