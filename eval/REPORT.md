# Detection + triage evaluation — 2026-09-25

**Status: labels UNREVIEWED.** All labels were drafted by the assistant from diffs and
templates. Every number below is provisional until a human reviews `eval/labels/`.

Target: DVinyl. Model: `jev-1.13.0`. Triage question set `acd087d75578`.
Reproduce: `npm run eval:prepare && npm run eval` (cached answers, no tokens) — `--live` to refill.

## Splits

| split | commits | how it was used |
|---|---|---|
| train | c44995f | detector and refactor question were tuned on it |
| dev | 75a47ed 6a0b330 39557d0 f3b2d6d a322cd4 72a2b3c 00f8f51 2140863 77859d1 97ec2e5 | looked at while designing: the route-span parser fix came from a322cd4, the template-chain state from 6a0b330 / f3b2d6d |
| **heldout** | 4a49e52 3005b51 b99bcdd 39cb66a 2d2a65d | labelled blind after the design was frozen, scored once |

Only held-out numbers are unbiased.

## Results (sure labels)

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

## What the numbers say

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

## Policy (PER-60) — provisional

Keep every detector candidate; use triage `value` only to order testing. Reason: triage has
not removed a single false positive on any split, and a precision gate cannot be set without
losing dev recall.

Observation, not acted on: `pAlters` separates train (TP ≥ 0.84, FP ≤ 0.80) and held-out
(TP ≥ 0.84, FP ≤ 0.81), but dev has true positives down to 0.70. A gate near 0.82 would be
chosen partly on held-out data and would cost dev recall. Needs a fresh batch to decide.

## Label judgment calls to review

These move the numbers most:

- **6a0b330** collection/wishlist labelled *sure* although the change only shows with a crafted artist name (XSS fix).
- **a322cd4** add/confirm pages labelled *sure* although the new text only shows when a provider fails.
- **2140863** login/setup labelled *sure*; fonts look the same while Google Fonts is reachable.
- **97ec2e5** 40 authenticated flows labelled *unsure* for the "session issued before a password change" scenario (global middleware).
- **c44995f / 4a49e52** create-path pages (confirm, manual add) labelled *not affected* because only the edit branch of `POST /save-X` changed.
- **2d2a65d** hex-id flows labelled *sure* for the "module off + id contains `cd`" scenario.
- **Correction made before any detection:** 2d2a65d label routes removed — they did not exist at the parent revision.

Definition used: `eval/labels/_definition.md`.
