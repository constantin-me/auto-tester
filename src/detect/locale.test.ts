import { test } from "node:test";
import assert from "node:assert/strict";
import { changedKeys, isLocaleFile, isStaticAsset, keyPathsByLine } from "./locale.js";
import { parseHunks } from "../diff/git.js";

const base = [
  "{", //                                   1
  '  "errors": {', //                       2
  '    "api_error": "Could not connect to Discogs.",', // 3
  '    "save_error": "Error while saving."', // 4
  "  },", //                                5
  '  "confirm_vinyl": {', //                6
  '    "api_error": "API Error.",', //       7
  '    "no_images": "No images found."', // 8
  "  }", //                                 9
  "}", //                                   10
].join("\n");

test("keyPathsByLine follows nesting", () => {
  const m = keyPathsByLine(base);
  assert.equal(m.get(3), "errors.api_error");
  assert.equal(m.get(7), "confirm_vinyl.api_error");
});

test("changedKeys: a changed value and a removed key", () => {
  const [changed] = parseHunks(["@@ -2,3 +2,3 @@", '   "errors": {', '-    "api_error": "Could not connect to Discogs.",', '+    "api_error": "Could not connect to {{provider}}.",', '     "save_error": "Error while saving."'].join("\n"));
  assert.deepEqual(changedKeys(base, changed!), ["errors.api_error"]);
  const [removed] = parseHunks(["@@ -6,3 +6,2 @@", '   "confirm_vinyl": {', '-    "api_error": "API Error.",', '     "no_images": "No images found."'].join("\n"));
  assert.deepEqual(changedKeys(base, removed!), ["confirm_vinyl.api_error"]);
});

test("file classes", () => {
  assert.equal(isLocaleFile("locales/en.json"), true);
  assert.equal(isLocaleFile("package.json"), false);
  assert.equal(isStaticAsset("public/vendor/fonts/poppins.css"), true);
  assert.equal(isStaticAsset("core/views/detail.ejs"), false);
});
