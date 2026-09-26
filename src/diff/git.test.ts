import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readCommit, splitPatch } from "./git.js";

const DVINYL = resolve(import.meta.dirname, "../../test-projects/DVinyl");

test("splitPatch yields one patch per file", () => {
  const diff = ["diff --git a/x.ts b/x.ts", "@@ -1 +1 @@", "-a", "+b", "diff --git a/y/z.ejs b/y/z.ejs", "@@ -1 +1 @@", "-c", "+d", ""].join("\n");
  const files = splitPatch(diff);
  assert.deepEqual(files.map((f) => f.path), ["x.ts", "y/z.ejs"]);
  assert.ok(files[1]!.patch.includes("+d") && !files[0]!.patch.includes("+d"));
});

test("readCommit reads a real DVinyl commit", { skip: !existsSync(resolve(DVINYL, ".git")) }, () => {
  const c = readCommit(DVINYL, "c44995f");
  assert.match(c.summary, /answer 404 when an item id is handed to another plugin/);
  assert.deepEqual(c.files.map((f) => f.path).sort(), ["core/routes/itemRoutes.ts", "utils/visibilityHelper.ts"]);
});

test("readCommit refuses option-like refs", () => {
  assert.throws(() => readCommit(DVINYL, "--output=/tmp/x"), /suspicious git ref/);
});
