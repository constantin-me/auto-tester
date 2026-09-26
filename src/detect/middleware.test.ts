import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appMounts, splitArgs } from "./middleware.js";
import { detectCandidates } from "./impact.js";
import { routesInText } from "../bootstrap/express.js";
import { emptyMindMap, type FlowNode } from "../mindmap/schema.js";

/** A tiny Express app on disk: two routers, two middlewares, one mounted between them. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mw-"));
  mkdirSync(join(root, "routes"));
  mkdirSync(join(root, "middleware"));
  const app = [
    "import express from 'express';", //                                 1
    "import early from './routes/early.js';", //                        2
    "import late from './routes/late.js';", //                          3
    "import admin from './routes/admin.js';", //                        4
    "import { checkUser } from './middleware/auth.js';", //             5
    "import { adminOnly } from './middleware/admin.js';", //            6
    "const app = express();", //                                        7
    "const SECRET = process.env.SECRET;", //                            8  boot code
    "app.use('/', early);", //                                          9
    "app.use(checkUser);", //                                          10
    "app.use((req, res, next) => {", //                                11  inline middleware
    "  res.locals.x = 1;", //                                          12
    "  next();", //                                                    13
    "});", //                                                          14
    "app.use('/admin', adminOnly);", //                                15  prefix-limited
    "app.use('/', late);", //                                          16
    "app.use('/admin', admin);", //                                    17
  ].join("\n");
  writeFileSync(join(root, "app.ts"), app);
  writeFileSync(join(root, "routes/early.ts"), "router.get('/early', (req, res) => res.render('early'));\n");
  writeFileSync(join(root, "routes/late.ts"), "router.get('/late', (req, res) => res.render('late'));\n");
  writeFileSync(join(root, "routes/admin.ts"), "router.get('/panel', (req, res) => res.render('panel'));\n");
  writeFileSync(join(root, "middleware/auth.ts"), "export function checkUser(req, res, next) {\n  next();\n}\n");
  writeFileSync(join(root, "middleware/admin.ts"), "export function adminOnly(req, res, next) {\n  next();\n}\n");

  const node = (id: string, route: string, file: string): FlowNode => ({
    id,
    label: id,
    route,
    view: undefined,
    views: [],
    kind: "page",
    requiresAuth: false,
    guards: [],
    assertions: [],
    provenance: { sourceFiles: [file], origin: "static-crawl", confidence: 0.6 },
  });
  const map = emptyMindMap("fixture");
  map.nodes = [node("node:early", "/early", "routes/early.ts"), node("node:late", "/late", "routes/late.ts"), node("node:admin-panel", "/admin/panel", "routes/admin.ts")];
  return { root, map };
}

const patch = (path: string, hunk: string) => ({ path, patch: `diff --git a/${path} b/${path}\n${hunk}\n` });
const flows = (root: string, map: ReturnType<typeof fixture>["map"], files: { path: string; patch: string }[]) =>
  detectCandidates(root, map, { summary: "t", files }, null, { expansions: [], globalPartialThreshold: 5, entry: "app.ts" })
    .candidates.map((c) => c.nodeId)
    .sort();

test("splitArgs respects nesting and strings", () => {
  assert.deepEqual(splitArgs("BASE_URL + '/a,b', fn(x, y), { a: 1, b: 2 }"), ["BASE_URL + '/a,b'", "fn(x, y)", "{ a: 1, b: 2 }"]);
});

test("appMounts: order, prefix, kinds", () => {
  const { root, map } = fixture();
  const files = new Set(map.nodes.map((n) => join(root, n.provenance.sourceFiles[0]!)));
  const m = appMounts(join(root, "app.ts"), readFileSync(join(root, "app.ts"), "utf8"), files);
  assert.deepEqual(
    m.map((x) => [x.kind, x.name ?? "-", x.prefix]),
    [
      ["router", "early", ""],
      ["middleware", "checkUser", ""],
      ["inline", "-", ""],
      ["middleware", "adminOnly", "/admin"],
      ["router", "late", ""],
      ["router", "admin", "/admin"],
    ],
  );
});

test("middleware mounted before a router reaches it; one mounted after does not", () => {
  const { root, map } = fixture();
  const got = flows(root, map, [patch("middleware/auth.ts", "@@ -1,3 +1,3 @@\n export function checkUser(req, res, next) {\n-  next();\n+  next(1);\n }")]);
  assert.deepEqual(got, ["node:admin-panel", "node:late"]); // not node:early, mounted before checkUser
});

test("prefix-limited middleware reaches only routes under its prefix", () => {
  const { root, map } = fixture();
  const got = flows(root, map, [patch("middleware/admin.ts", "@@ -1,3 +1,3 @@\n export function adminOnly(req, res, next) {\n-  next();\n+  next(1);\n }")]);
  assert.deepEqual(got, ["node:admin-panel"]);
});

test("a hunk inside an inline app.use handler is middleware; boot code is not", () => {
  const { root, map } = fixture();
  const inline = flows(root, map, [patch("app.ts", "@@ -11,4 +11,4 @@\n app.use((req, res, next) => {\n-  res.locals.x = 1;\n+  res.locals.x = 2;\n   next();\n });")]);
  assert.deepEqual(inline, ["node:admin-panel", "node:late"]);
  const boot = flows(root, map, [patch("app.ts", "@@ -8,1 +8,1 @@\n-const SECRET = process.env.SECRET;\n+const SECRET = process.env.SECRET || 'x';")]);
  assert.deepEqual(boot, []);
});

test("router.use guards apply to the routes declared after it", () => {
  const src = ["router.get('/open', h);", "router.use(requireAuth, requireRole('admin'));", "router.get('/closed', h);"].join("\n");
  const [open, closed] = routesInText(src, "/x/r.ts", "r.ts", [""], []);
  assert.deepEqual(open!.guards, []);
  assert.deepEqual(closed!.guards, ["requireAuth", "requireRole:admin"]);
});
