# Running auto-tester in CI

`github-workflow.yml` is a template for the **app's** repository. It builds the PR's base,
records a baseline, rebuilds at the head, checks the change, and uploads `report.md` /
`report.json` as an artifact. It is advisory: the check step always succeeds.

## Before enabling it

1. **Config in the app repo.** Put `autotester.config.json` at the repo root with
   `"appRoot": "."`, the `env.baseUrl` the CI app answers on, and the auth recipe using
   `${QA_USER}` / `${QA_PASS}`. Per the design, the mind-map lives in the app repo too
   (`store.dir`, committed), so changes to it show up in PR diffs.
2. **Build and start.** The template uses `docker compose up -d --build` from the checkout
   (compose must build from source, not pull a published image, or the check tests the
   wrong code).
3. **Test user and data.** A fresh CI database is empty. Replace the seed step with
   something app-specific: create `QA_USER`, and load a small fixture so pages with `:id`
   routes have live links (otherwise those flows are reported "untestable-no-data").
4. **Secrets.** `TYPESAFE_API_KEY`, `QA_USER`, `QA_PASS` in the repo's Actions secrets.
5. **PR comments** are commented out. Enabling them needs `pull-requests: write` and
   posts every report publicly on the PR.

## Cost per PR

One Jev request per candidate flow for triage, plus one per indirectly linked flow for
the execution check, plus a few per finding. On DVinyl: 1–80 requests, 2k–100k tokens,
depending on how widely the change reaches. Answers are cached per change, so re-runs
of the same commit are free when `.autotester/cache` is kept (add an `actions/cache` step
if you want that across runs).
