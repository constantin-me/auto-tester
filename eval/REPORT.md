# Detection + triage evaluation

**Status: labels UNREVIEWED.** All labels were drafted by the assistant from diffs and
templates. Every number below is provisional until a human reviews `eval/labels/`.

## Round 3 — 2026-09-26: Jev live on everything + execution check (PER-69)

Labels for train/dev/batch 1/batch 2 reviewed by the user at rule level (error-path,
crafted-input and scenario changes count as affected). Batch 3 labels are not yet reviewed.
Jev spend this round: 544k (full triage) + 180k (execution check, design data) + 234k (batch 3).

| (sure labels) | detector R / P | + Jev triage | + execution check |
|---|---|---|---|
| DEV pooled | 0.99 / 0.55 | 0.97 / 0.69 | 0.96 / 0.69 (at the pre-registered 0.2) |
| DEV + TRAIN, execution check at 0.45 | | 0.97 / 0.67 | **0.97 / 0.83** |
| HELDOUT2 pooled | 0.97 / 0.98 | 0.97 / 0.98 | 0.97 / 0.98 |
| **HELDOUT3 pooled** (scored once) | 1.00 / 0.99 | **1.00 / 1.00** | 0.99 / 1.00 |
| HELDOUT3 dedup | 1.00 / 0.96 | 1.00 / 1.00 | 0.96 / 1.00 |

- **Every false positive on every split comes from an indirect link** (middleware, a page
  action posting to a changed handler, a helper chain). Direct handler/template hits: 0 false
  positives across dev, train and batch 3.
- **Jev triage gate: confirmed.** Untuned defaults removed 29 of 64 dev false positives for one
  true positive, and on batch 3 removed its only false positive with no loss.
- **Execution check (separate Jev request, evidence built in code):** the pre-registered drop
  threshold 0.2 did nothing (Jev answers are moderate). Re-set on dev+train only to 0.45, the
  highest value with zero recall loss there (precision 0.67 → 0.83). On batch 3 it saw only 4
  indirect candidates and dropped one true positive (8707d43 `/collection`: the bulk print now
  sorts and keeps empty sheets; P(differs) 0.27). **Promising on dev, unproven on held-out.**
- **Middleware is still unmeasured on held-out data:** batch 3's `app.ts` commits changed boot
  code and view locals only. 887c1c7 (boot code) correctly produced zero candidates.

---

## Round 2 — 2026-09-26: recall fixes (PER-62 / PER-65 / PER-66), detector only

Held-out batch 2 (PER-67) was selected by a fixed rule (6 newest unused app-code commits)
and labelled **before** any fix was written. Batch 1 became dev once the fixes were built
from its misses. Jev was not re-run: the new state invalidates the cache (~158k tokens for
batch 2 alone) and needs approval. Under the provisional policy every detector candidate is
kept, so the detector score is the system score.

| (sure labels) | recall | precision |
|---|---|---|
| DEV before fixes (batch 1 merged into dev) | 0.81 | 0.84 |
| DEV + PER-65 all views + PER-66 route-table handlers | 0.85 | 0.85 |
| DEV + PER-62 app-level middleware | **0.99** | 0.55 |
| DEV + PER-62, counting unsure labels | 0.99 (was 0.50) | 0.65 |
| **HELDOUT2 pooled** | **0.97** | **0.93** |
| **HELDOUT2 dedup** | **0.93** | **0.93** |

- **Middleware (PER-62) buys recall with precision:** 103 dev candidates are reached only
  through `app.use`; the detector knows the middleware runs on every later request, not which
  paths its new logic touches. That judgment is left to Jev (unmeasured until a live run).
- **Batch 2 has no middleware commit**, so PER-62 is unmeasured on held-out data; its header
  commits (76 of 95 labels) are the template-chain case, which is why dedup is the fairer figure.
- **Batch 2 misses (3):** `/dvd/:id/episodes` ×2 (renders through a computed template path, so
  no view is recorded) · `/admin` in a67e7a7 (the refresh-all handler's span is cut short again,
  most likely a regex literal or nested template string confusing the quote tracking).
- **Batch 2 false positives (7):** confirm ×5 in 1d51fdb (the confirm handler renders `add.ejs`
  on its error path; labelled not affected) · two backup exports in 018e6a8 (pure refactors).
- **Label inconsistency to resolve in review:** an error-path-only change was labelled
  *affected* in a322cd4 but *not affected* in 1d51fdb. Not changed after seeing the detector.
- **Train label correction (disclosed):** c44995f gained `node:root` — the dashboard includes
  the move script that calls the changed API. Found because the detector flagged it, so it can
  only favour the detector.
- Dev residual miss: 3005b51 `/dvd/:id/episodes`, guarded by middleware attached through a
  route-table flag (`allowShareView` → `shareScopeGuard`).

---

## Round 1 — 2026-09-25

Target: DVinyl. Model: `jev-1.13.0`. Triage question set `acd087d75578`.
Reproduce: `npm run eval:prepare && npm run eval` (cached answers, no tokens) — `--live` to refill.

### Splits

| split | commits | how it was used |
|---|---|---|
| train | c44995f | detector and refactor question were tuned on it |
| dev | 75a47ed 6a0b330 39557d0 f3b2d6d a322cd4 72a2b3c 00f8f51 2140863 77859d1 97ec2e5 | looked at while designing: the route-span parser fix came from a322cd4, the template-chain state from 6a0b330 / f3b2d6d |
| **heldout** | 4a49e52 3005b51 b99bcdd 39cb66a 2d2a65d | labelled blind after the design was frozen, scored once |

Only held-out numbers are unbiased.

### Results (sure labels)

| | detector recall | detector precision | + Jev triage recall | + Jev triage precision |
|---|---|---|---|---|
| **HELDOUT pooled** | **0.62** | **0.69** | 0.62 | 0.69 |
| HELDOUT dedup (plugin siblings = 1) | 0.53 | 0.73 | 0.53 | 0.73 |
| DEV pooled | 1.00 | 0.98 | 1.00 | 0.98 |
| TRAIN | 1.00 | 0.57 | 1.00 | 0.57 |

Dev → held-out drop is the cost of having designed on dev. The held-out figure is the
honest one.

Zero dropped hits on every split (no flow reached by detection was missing from its map),
so no miss above is a map/code mismatch. Jev spend: 293,095 tokens across the three eval
runs (~490k including the earlier `jev:smoke` runs).

### What the numbers say

1. **The static detector does the useful work. Jev triage currently only ranks.** Under the
   default policy triage removed zero false positives on any split, and before the
   template-chain state fix it cut dev recall from 1.00 to 0.75.
2. **Held-out misses have three causes, none of them Jev:**
   - app-level middleware not attributed to routes — 2d2a65d, 0/11 (PER-62; also 97ec2e5's 40 unsure flows)
   - crawler keeps only the first `res.render` of a handler, so pages whose handler renders an
     early-return view first lose their real template chain — b99bcdd, 3 of 4 missed (new issue)
   - route tables with an inline `handler() {}` method are not mapped — 3005b51 `/dvd/:id/episodes`
3. **Held-out false positives are one shape:** a shared POST handler changed in a branch some
   callers never take (4a49e52 save: edit branch changed, create-flow pages flagged) — 11 of 11.
   Same shape as the 12 train false positives (PER-64).

### Policy (PER-60) — provisional

Keep every detector candidate; use triage `value` only to order testing. Reason: triage has
not removed a single false positive on any split, and a precision gate cannot be set without
losing dev recall.

Observation, not acted on: `pAlters` separates train (TP ≥ 0.84, FP ≤ 0.80) and held-out
(TP ≥ 0.84, FP ≤ 0.81), but dev has true positives down to 0.70. A gate near 0.82 would be
chosen partly on held-out data and would cost dev recall. Needs a fresh batch to decide.

## Label judgment calls to review

- **1d51fdb vs a322cd4** error-path-only changes labelled inconsistently (see round 2).

These move the numbers most:

- **6a0b330** collection/wishlist labelled *sure* although the change only shows with a crafted artist name (XSS fix).
- **a322cd4** add/confirm pages labelled *sure* although the new text only shows when a provider fails.
- **2140863** login/setup labelled *sure*; fonts look the same while Google Fonts is reachable.
- **97ec2e5** 40 authenticated flows labelled *unsure* for the "session issued before a password change" scenario (global middleware).
- **c44995f / 4a49e52** create-path pages (confirm, manual add) labelled *not affected* because only the edit branch of `POST /save-X` changed.
- **2d2a65d** hex-id flows labelled *sure* for the "module off + id contains `cd`" scenario.
- **Correction made before any detection:** 2d2a65d label routes removed — they did not exist at the parent revision.

Definition used: `eval/labels/_definition.md`.
