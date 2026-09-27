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
