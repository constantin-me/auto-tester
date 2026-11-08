import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assertion, FlowNode, MindMap } from "../mindmap/schema.js";
import { JevCache } from "../jev/cache.js";
import { ViewIndex } from "../bootstrap/ejs.js";
import { extractRoutes } from "../bootstrap/express.js";
import type { EnrichClient, EnrichRequest } from "./client.js";
import type { EnrichOutput } from "./schema.js";
import { enrich, plan, type CachedAnswer } from "./enrich.js";
import { gatherEvidence } from "./evidence.js";

const prov = (origin: Assertion["provenance"]["origin"]) => ({ sourceFiles: [], origin, confidence: 0.5 });
const assertion = (id: string, origin: Assertion["provenance"]["origin"], pinned = false, expectation = id): Assertion => ({
  id,
  expectation,
  severityIfBroken: 3,
  pinned,
  provenance: prov(origin),
});

/** a tiny express+ejs app on disk: one handler inline, one by reference, one big template */
function fixtureApp() {
  const root = mkdtempSync(join(tmpdir(), "enrich-"));
  mkdirSync(join(root, "views"));
  mkdirSync(join(root, "routes"));
  writeFileSync(join(root, "app.ts"), `app.set('views', path.join(__dirname, 'views'));\napp.use('/', pages);\n`);
  writeFileSync(
    join(root, "routes", "pages.ts"),
    [
      `import { aboutGet } from './about';`,
      `router.get('/login', (req, res) => {`,
      `  res.render('login');`,
      `});`,
      `router.get('/about', aboutGet);`,
      `router.get('/big', (req, res) => res.render('big'));`,
      ``,
    ].join("\n"),
  );
  writeFileSync(join(root, "routes", "about.ts"), `export const aboutGet = (req, res) => {\n  res.render('about', { team: 'x' });\n};\n`);
  writeFileSync(join(root, "views", "login.ejs"), `<form action="/login" method="post"><button>Sign in</button></form>`);
  writeFileSync(join(root, "views", "about.ejs"), `<h1>About us</h1>`);
  writeFileSync(join(root, "views", "big.ejs"), "x".repeat(5000));
  return root;
}

const node = (id: string, route: string, view: string, assertions: Assertion[] = []): FlowNode => ({
  id,
  label: route,
  route,
  view,
  views: [view],
  kind: "page",
  requiresAuth: false,
  guards: [],
  assertions,
  provenance: prov("static-crawl"),
});

const mapOf = (nodes: FlowNode[]): MindMap => ({ schemaVersion: 1, repo: "t", generatedAt: "2026-01-01T00:00:00.000Z", nodes, edges: [] });

const ctxFor = (root: string, maxEvidenceChars = 100_000) => ({
  appRoot: root,
  routes: extractRoutes(root, join(root, "app.ts"), []),
  views: new ViewIndex(root, ["views"]),
  edges: [],
  maxEvidenceChars,
});

const output = (slugs: string[]): EnrichOutput => ({
  label: "Sign in",
  confidence: 0.95,
  assertions: slugs.map((slug) => ({ slug, expectation: `expect ${slug}`, check: null, severityIfBroken: 9 })),
});

function fakeClient(out: EnrichOutput) {
  const calls: EnrichRequest[] = [];
  const client: EnrichClient = {
    async enrich(req) {
      calls.push(req);
      return { ok: true, output: out, usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
  return { client, calls };
}

const settings = { model: "m", effort: "low" as const, concurrency: 2 };

test("evidence has the inline handler, a by-reference handler and the template; oversize is skipped, not cut", () => {
  const root = fixtureApp();
  const login = gatherEvidence(node("node:login", "/login", "login"), ctxFor(root));
  assert.ok(login.ok);
  assert.match(login.text, /res\.render\('login'\)/);
  assert.match(login.text, /Sign in/);

  const about = gatherEvidence(node("node:about", "/about", "about"), ctxFor(root));
  assert.ok(about.ok);
  assert.match(about.text, /aboutGet = /, "the referenced handler body is sent");
  assert.ok(about.sourceFiles.includes("routes/about.ts") && about.sourceFiles.includes("views/about.ejs"));

  const big = gatherEvidence(node("node:big", "/big", "big"), ctxFor(root, 1000));
  assert.ok(!big.ok);
  assert.match(big.reason, /skipped-too-large.*limit 1000/);

  const ep = gatherEvidence({ ...node("node:x", "/x", "x"), kind: "endpoint" }, ctxFor(root));
  assert.ok(!ep.ok);
});

test("enrichment writes llm-author assertions with stable ids, clamped severity, a label and sourceFiles", async () => {
  const root = fixtureApp();
  const map = mapOf([node("node:login", "/login", "login")]);
  const cache = new JevCache<CachedAnswer>(null, "m");
  const { client, calls } = fakeClient(output(["Shows form", "shows form", "Submit works!"]));
  const { map: out, results } = await enrich(map, plan(map, ctxFor(root), settings, cache), client, cache, settings);

  const n = out.nodes[0]!;
  assert.equal(n.label, "Sign in");
  assert.deepEqual(
    n.assertions.map((a) => a.id),
    ["llm:node:login:shows-form", "llm:node:login:shows-form-2", "llm:node:login:submit-works"],
  );
  assert.ok(n.assertions.every((a) => a.provenance.origin === "llm-author" && !a.pinned && a.severityIfBroken === 5));
  assert.ok(n.assertions[0]!.provenance.confidence <= 0.9);
  assert.ok(n.assertions[0]!.provenance.sourceFiles.includes("views/login.ejs"));
  assert.deepEqual(results[0]!.usage, { inputTokens: 100, outputTokens: 50 });
  assert.equal(calls.length, 1);
});

test("re-run replaces llm-author assertions, keeps pinned and qa-observed ones; a pinned id collision survives unchanged", async () => {
  const root = fixtureApp();
  const pinned = assertion("llm:node:login:shows-form", "human", true, "HUMAN WORDING");
  const observed = assertion("qa:node:login:status:1", "qa-observed");
  const stale = assertion("llm:node:login:old-claim", "llm-author");
  const map = mapOf([node("node:login", "/login", "login", [pinned, observed, stale])]);
  const cache = new JevCache<CachedAnswer>(null, "m");
  const { client } = fakeClient(output(["shows-form", "fresh-claim"]));
  const { map: out } = await enrich(map, plan(map, ctxFor(root), settings, cache), client, cache, settings);

  const byId = new Map(out.nodes[0]!.assertions.map((a) => [a.id, a]));
  assert.deepEqual(byId.get(pinned.id), pinned, "pinned assertion is identical despite the id collision");
  assert.deepEqual(byId.get(observed.id), observed);
  assert.ok(!byId.has(stale.id), "old llm-author assertion is replaced");
  assert.ok(byId.has("llm:node:login:fresh-claim"));
  assert.equal(out.nodes[0]!.assertions.filter((a) => a.id === pinned.id).length, 1);
});

test("second run is answered from the cache: no client call, same assertions", async () => {
  const root = fixtureApp();
  const map = mapOf([node("node:login", "/login", "login")]);
  const cache = new JevCache<CachedAnswer>(null, "m");
  const { client, calls } = fakeClient(output(["a-claim"]));
  const first = await enrich(map, plan(map, ctxFor(root), settings, cache), client, cache, settings);

  const items = plan(first.map, ctxFor(root), settings, cache);
  assert.equal(items[0]!.status, "cached");
  const second = await enrich(first.map, items, client, cache, settings);
  assert.equal(calls.length, 1);
  assert.equal(second.results[0]!.status, "cached");
  assert.deepEqual(second.map.nodes[0]!.assertions, first.map.nodes[0]!.assertions);
});

test("a failed call leaves the node untouched and is not cached", async () => {
  const root = fixtureApp();
  const before = node("node:login", "/login", "login", [assertion("llm:node:login:old", "llm-author")]);
  const map = mapOf([before]);
  const cache = new JevCache<CachedAnswer>(null, "m");
  const client: EnrichClient = { enrich: async () => ({ ok: false, reason: "model refused", usage: { inputTokens: 7, outputTokens: 0 } }) };
  const { map: out, results } = await enrich(map, plan(map, ctxFor(root), settings, cache), client, cache, settings);
  assert.deepEqual(out.nodes[0], before);
  assert.equal(results[0]!.status, "failed");
  assert.equal(results[0]!.reason, "model refused");
  assert.equal(plan(map, ctxFor(root), settings, cache)[0]!.status, "send");
});

test("--only and --limit narrow the plan", () => {
  const root = fixtureApp();
  const map = mapOf([node("node:login", "/login", "login"), node("node:about", "/about", "about")]);
  const cache = new JevCache<CachedAnswer>(null, "m");
  assert.deepEqual(plan(map, ctxFor(root), { ...settings, only: new Set(["node:about"]) }, cache).map((i) => i.node.id), ["node:about"]);
  assert.equal(plan(map, ctxFor(root), { ...settings, limit: 1 }, cache).length, 1);
});
