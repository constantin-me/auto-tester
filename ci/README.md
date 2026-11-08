# Running auto-tester in CI

**Status: never run on GitHub; rehearsed locally end to end.** `ci/rehearse.sh <app-repo>
<base> <head>` runs the workflow's steps in the same order on a clone of the app (its own
compose project on :3299, Jev cache kept in `.autotester/ci-cache` like `actions/cache`):
build at base, `qa:seed`, bootstrap, baseline, rebuild at head, `qa:check`. On DVinyl
`a589636`: 37 flows baselined, 5 affected, 5 passed; 47k tokens for the baseline with a warm
cache, 7k for the check. What remains for a first real run: GitHub-only behaviour (runner
sandbox, checkout token, artifact upload).

`github-workflow.yml` is a template for the **app's** repository. It builds the PR's base,
records a baseline, rebuilds at the head, checks the change, and uploads `report.md` /
`report.json` as an artifact. It is advisory: the check step always succeeds.

## Before enabling it

1. **Config in the app repo.** Put `autotester.config.json` at the repo root with
   `"appRoot": "."`, the `env.baseUrl` the CI app answers on, and the auth recipe using
   the fixture's login, `"qa": { "disposable": true, "seed": {...}, "runsDir": ".autotester/runs" }` so reports and
   the answer cache land inside the workspace (the default `../.autotester/runs` suits a config
   kept in a subfolder; in CI it would resolve outside the checkout and the artifact step would
   upload nothing). Per the design, the mind-map lives in the app repo too
   (`store.dir`, committed), so changes to it show up in PR diffs.
2. **Build and start.** The template uses `docker compose up -d --build` from the checkout
   (compose must build from source, not pull a published image, or the check tests the
   wrong code).
3. **Test user and data.** A fresh CI database is empty. Load a fixture with
   `npm run qa:seed -- <config>`: it POSTs `qa.seed.file` to `qa.seed.path` (the app's own
   restore endpoint) and refuses unless the config sets `qa.disposable: true`. The fixture
   carries a known test user, so its credentials are public and need no secrets. Worked
   example for DVinyl: `examples/dvinyl-qa.config.json`, `examples/fixtures/dvinyl-qa.json`
   (built through the app's own forms, then exported), and `examples/dvinyl-qa.compose.yml`
   for a throwaway instance next to a developer's own. With `qa.harvestDepth: 2`, detail
   pages' links (edit, label) are found too: 37 of 62 DVinyl flows testable, against 15
   without data.
4. **Secrets.** Only `TYPESAFE_API_KEY`. The test login comes from the committed fixture.
5. **PR comments** are commented out. Enabling them needs `pull-requests: write` and
   posts every report publicly on the PR.

## Cost per PR

One Jev request per candidate flow for triage, plus one per indirectly linked flow for
the execution check, plus a few per finding. On DVinyl: 1–80 requests, 2k–100k tokens,
depending on how widely the change reaches. The baseline runs on every PR: about 230k
tokens cold, about 10–50k once `.autotester/cache` is warm. The template keeps it with
`actions/cache`, so unchanged pages and repeated questions cost nothing.

## Likely first failures (verify, not yet fixed)

- **Headless Chrome sandbox** on ubuntu-24.04 runners (AppArmor restricts unprivileged user
  namespaces). Puppeteer may need `--no-sandbox` there: set `"qa": { "launchArgs": ["--no-sandbox"] }` in the
  app's config (opt-in; only on a runner you trust, since it turns off Chrome's sandbox).
- **The app's `.env`** is written by the template with fresh random secrets (DVinyl refuses
  empty or published ones). Another app needs its own version of that step.
- **A private auto-tester repo** needs `token:` on the second checkout.
- **Only the check step is guarded** (`|| true`). A failing build, seed or baseline step turns
  the job red; decide whether that is right for an advisory job.
- **The baseline rewrites the committed mind-map** in the runner's checkout; the template keeps
  it across the head checkout, and `STORE_DIR` must match `store.dir` in the config.
