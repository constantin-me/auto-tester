import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetLedger, mapGated } from "./ledger.js";

const use = (purpose: string, inputTokens: number, outputTokens = 0) => ({ purpose, model: "m", inputTokens, outputTokens });

test("ledger: debits, per-purpose totals, remaining, exhausted", () => {
  const l = new BudgetLedger(100);
  l.debit(use("triage", 30, 10));
  l.debit(use("triage", 20));
  l.debit(use("severity", 10));
  assert.equal(l.spent, 70);
  assert.equal(l.remaining, 30);
  assert.equal(l.exhausted, false);
  assert.deepEqual(l.byPurpose, { triage: 60, severity: 10 });
  l.debit(use("severity", 50));
  assert.equal(l.remaining, 0);
  assert.equal(l.exhausted, true);
});

test("ledger: triage stops at the reserve line, checks can spend to the cap", () => {
  const l = new BudgetLedger(100, 0.3);
  l.debit(use("triage", 69));
  assert.equal(l.mayStart("triage"), true);
  l.debit(use("triage", 1));
  assert.equal(l.mayStart("triage"), false);
  assert.equal(l.mayStart("check"), true);
  l.debit(use("observation", 30));
  assert.equal(l.mayStart("check"), false);
});

test("ledger: rejects a bad cap or reserve", () => {
  assert.throws(() => new BudgetLedger(0));
  assert.throws(() => new BudgetLedger(10, 1.5));
});

test("mapGated: once exhausted nothing new starts; the in-flight item finishes and is debited", async () => {
  const l = new BudgetLedger(100);
  const started: number[] = [];
  const finished: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  // concurrency 2: item 0 is in flight (slow) when item 1 exhausts the budget
  const run = mapGated([0, 1, 2, 3], 2, l, "triage", async (i) => {
    started.push(i);
    if (i === 1) {
      l.debit(use("triage", 100));
    } else {
      await gate;
      l.debit(use("triage", 40)); // in flight when the cap was crossed: allowed, overshoots
    }
    finished.push(i);
    return i;
  });
  await new Promise((r) => setTimeout(r, 10));
  release();
  const out = await run;
  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(finished.sort(), [0, 1]);
  assert.deepEqual(out.map((o) => o.started), [true, true, false, false]);
  assert.equal(l.spent, 140);
  assert.ok(l.exhausted);
});

test("mapGated: free items (cache hits) run even when exhausted", async () => {
  const l = new BudgetLedger(10);
  l.debit(use("triage", 10));
  const out = await mapGated([1, 2], 1, l, "triage", async (i) => i * 2, (i) => i === 2);
  assert.deepEqual(out, [{ started: false }, { started: true, value: 4 }]);
});
