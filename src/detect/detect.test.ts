import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { declarations, stripComments } from "./declarations.js";
import { parseHunks, touchedBaseLines, spanTouched, readCommit } from "../diff/git.js";
import { detectCandidates } from "./impact.js";
import { routesInText } from "../bootstrap/express.js";
import { loadConfig } from "../config/config.js";
import { makeStore } from "../store/store.js";

test("declarations: functions and arrow consts only, not value locals", () => {
  const src = [
    "export function a() {", //        1
    "  const plugin = registry.get(x);", // 2  value local: not a symbol
    "  const inner = (q) => {", //    3
    "    return q;", //               4
    "  };", //                        5
    "}", //                           6
    "export const b = async (req, res) => res.send(1);", // 7
  ].join("\n");
  const d = declarations(src).map((x) => `${x.name}:${x.start}-${x.end}`);
  assert.deepEqual(d, ["a:1-6", "inner:3-5", "b:7-7"]);
});

test("stripComments keeps line count and strings", () => {
  const src = "a // createItemRoutes\n/* x\ny */ b 'http://k'";
  const out = stripComments(src);
  assert.equal(out.split("\n").length, 3);
  assert.ok(!out.includes("createItemRoutes"));
  assert.ok(out.includes("'http://k'"));
});

test("an apostrophe in a comment does not cut a handler's span short", () => {
  const src = [
    "router.post('/search', requireAuth, async (req, res) => {", // 1
    "  // a seller's name, not what the user typed", //            2
    "  const x = 1;", //                                            3
    "  res.render('add', { error: req.t('e') });", //               4
    "});", //                                                       5
    "router.get('/other', (req, res) => res.send(''));", //         6
  ].join("\n");
  const [search, other] = routesInText(src, "/x/r.ts", "r.ts", [""], []);
  assert.deepEqual(search!.span, { start: 1, end: 5 });
  assert.equal(search!.view, "add");
  assert.deepEqual(other!.span, { start: 6, end: 6 });
});

test("touchedBaseLines ignores context lines; pure additions are insertion points", () => {
  const [h] = parseHunks(["@@ -10,4 +10,5 @@", " ctx10", "-old11", "+new11", "+new12", " ctx12", " ctx13"].join("\n"));
  const t = touchedBaseLines(h!);
  assert.deepEqual(t, { removed: [11], insertedAfter: [11] });
  const [add] = parseHunks(["@@ -22,3 +22,5 @@", " a", " }", "+fn1", "+fn2", " next"].join("\n"));
  const ta = touchedBaseLines(add!);
  assert.deepEqual(ta, { removed: [], insertedAfter: [23] });
  // inserted right after a function's closing line: not inside that function
  assert.equal(spanTouched({ start: 20, end: 23 }, ta), false);
  assert.equal(spanTouched({ start: 20, end: 24 }, ta), true);
});

const DVINYL = resolve(import.meta.dirname, "../../DVinyl");
const CONFIG = resolve(import.meta.dirname, "../../examples/dvinyl.config.json");

test("c44995f: detects the changed item handlers, not unrelated flows", { skip: !existsSync(resolve(DVINYL, ".git")) }, () => {
  const { config, baseDir } = loadConfig(CONFIG);
  const map = makeStore(config.store.backend, baseDir, config.store.dir).load(config.repo);
  if (!map.nodes.length) return; // needs a bootstrapped map
  const { candidates, unmapped } = detectCandidates(DVINYL, map, readCommit(DVINYL, "c44995f"), "c44995f~1", config.crawler);
  const ids = new Set(candidates.map((c) => c.nodeId));
  for (const id of ["node:book-id", "node:album-edit-id", "node:lego-id-label", "node:wishlist"]) assert.ok(ids.has(id), id);
  for (const id of ["node:login", "node:settings", "node:admin-instance"]) assert.ok(!ids.has(id), id);
  // helper additions and import edits have no callers at the base revision
  assert.equal(unmapped.length, 2);
  // no reason may come from a symbol found only in a comment
  assert.ok(candidates.every((c) => c.reasons.every((r) => !r.includes("createItemRoutes"))));
});
