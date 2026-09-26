# Label definition

A flow (a `page` or `endpoint` node of the commit's parent-tree mind-map) is
**affected** when a user going through it could observe something different after
the commit: rendered output (visual changes included), navigation/redirects, status
codes, validation, what is saved or downloaded, or behavior under a specific input
or scenario (e.g. a crafted value, a provider failure, a password change elsewhere).

- A pure refactor (same inputs, same results) is **not** affected.
- A changed POST/DELETE handler is labelled on the pages whose forms/fetches call it,
  only when the branch those pages use actually changed.
- Synthetic nodes (global navigation) are not labelled.
- Every flow not listed as affected is **not affected**.
- `sure` / `unsure` is the labeller's confidence. `unsure` labels are scored both ways.
- Labels were written from the diff and templates BEFORE running the detector.
- `reviewed: false` until a human has checked them; results are marked UNREVIEWED until then.
