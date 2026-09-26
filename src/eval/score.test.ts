import { test } from "node:test";
import assert from "node:assert/strict";
import { score, dedupeByTemplate, type FlowRow } from "./score.js";

const row = (flow: string, label: FlowRow["label"], candidate: boolean, predicted?: boolean): FlowRow => ({
  commit: "c1",
  split: "dev",
  flow,
  label,
  candidate,
  predicted,
});

test("detector vs system scoring, unsure excluded or counted", () => {
  const rows = [
    row("node:a", "sure", true, true), // tp both
    row("node:b", "sure", true, false), // detector tp, system fn
    row("node:c", "sure", false), // fn both
    row("node:d", null, true, false), // detector fp, system tn
    row("node:e", "unsure", true, true), // excluded in "sure" mode
    row("node:f", null, false), // tn
  ];
  assert.deepEqual(score(rows, "sure", "detector"), { tp: 2, fp: 1, fn: 1, tn: 1, recall: 2 / 3, precision: 2 / 3 });
  assert.deepEqual(score(rows, "sure", "system"), { tp: 1, fp: 0, fn: 2, tn: 2, recall: 1 / 3, precision: 1 });
  assert.equal(score(rows, "all", "detector").tp, 3);
});

test("zero positives and zero predictions give null, not NaN", () => {
  const m = score([row("node:a", null, false)], "sure", "detector");
  assert.equal(m.recall, null);
  assert.equal(m.precision, null);
});

test("plugin siblings collapse to one template per commit", () => {
  const rows = [row("node:book-id", "sure", true), row("node:dvd-id", "sure", false), row("node:add-books-manual", null, true)];
  const d = dedupeByTemplate(rows, ["book", "dvd", "books"]);
  assert.deepEqual(
    d.map((r) => [r.flow, r.label, r.candidate]),
    [
      ["node:X-id", "sure", true],
      ["node:add-X-manual", null, true],
    ],
  );
});
