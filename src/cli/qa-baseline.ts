import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/config.js";
import { makeStore } from "../store/store.js";
import { toMermaid } from "../mindmap/mermaid.js";
import { QaSession } from "../qa/driver.js";
import { candidateTexts, chromeAssertions, classify, globalTexts, observedAssertions, planVisits, withObserved, type FlowStatus } from "../qa/plan.js";
import { Judge, mapLimit, type UsageRecord } from "../jev/client.js";
import { classifyUiTexts, type UiText } from "../jev/judgments.js";

/**
 * M4 slice 1: visit every mapped page of the running app read-only and record what it
 * looks like, as `qa-observed` facts on the mind-map (a reviewable diff).
 *
 *   npm run qa:baseline -- examples/dvinyl.config.json
 *
 * Evidence (screenshots, observations) goes to qa.runsDir/<timestamp>/, gitignored.
 */
async function main() {
  const configArg = process.argv[2];
  if (!configArg || !existsSync(configArg)) {
    console.error("usage: npm run qa:baseline -- <path-to-config.json>");
    process.exit(2);
  }
  const { config, baseDir } = loadConfig(configArg);
  if (!config.env.baseUrl) throw new Error("config.env.baseUrl is required for QA runs");
  const store = makeStore(config.store.backend, baseDir, config.store.dir);
  const map = store.load(config.repo);
  const at = new Date().toISOString();
  const runDir = resolve(baseDir, config.qa.runsDir, at.replace(/[:.]/g, "-"));
  const loginPath = config.auth.loginPath ?? "/login";
  const usage: UsageRecord[] = [];

  console.log(`[qa] ${config.env.baseUrl} — read-only${config.qa.allowWrites ? " OFF (writes allowed)" : ""}; evidence -> ${runDir}`);
  const session = await QaSession.open({ baseUrl: config.env.baseUrl, auth: config.auth, allowWrites: config.qa.allowWrites });
  console.log("[qa] logged in");

  try {
    const links = await session.harvestLinks(config.qa.seedPaths);
    const plan = planVisits(map.nodes, links, config.qa);
    const visits = plan.filter((p) => p.path);
    console.log(`[qa] ${links.length} live links harvested; visiting ${visits.length} of ${plan.length} flows`);

    const results = await mapLimit(visits, config.qa.concurrency, async (v) => {
      const ev = await session.visit(v.path!, runDir, v.node.id.replace(/[^\w-]+/g, "_"));
      return { v, ev, ...classify(ev, loginPath, v.path!) };
    });

    // a redirect to login is by design for some pages; a lost session shows on "/" too
    const home = await session.visit("/");
    if (home.finalPath === loginPath) throw new Error("session lost during the run (\"/\" now redirects to the login page)");

    const byId = new Map(results.map((r) => [r.v.node.id, r]));
    const statusOf = new Map<string, { status: FlowStatus; reason: string; path?: string; http?: number }>();
    for (const p of plan) {
      const r = byId.get(p.node.id);
      statusOf.set(p.node.id, r ? { status: r.status, reason: r.reason, path: p.path, http: r.ev.httpStatus } : { status: p.status!, reason: p.reason ?? "" });
    }

    // which texts to assert on: shared chrome once on the navigation node; the rest only
    // when Jev reads them as fixed interface rather than the user's data
    const loaded = results.filter((r) => r.status === "ok" && r.ev.finalPath === r.v.path);
    const textsOf = new Map(loaded.map((r) => [r.v.node.id, candidateTexts(r.ev)]));
    const chrome = globalTexts([...textsOf.values()]);
    const judge = new Judge({ model: config.jev.model, onUsage: (u) => usage.push(u) });
    const kept = new Map<string, UiText[]>();
    await mapLimit(loaded, config.jev.concurrency, async (r) => {
      const own = textsOf.get(r.v.node.id)!.filter((t) => !chrome.has(t.text));
      const verdicts = await classifyUiTexts(judge, { route: r.v.node.route!, title: r.ev.structure.title, hasParams: r.v.node.route!.includes(":") }, own);
      kept.set(r.v.node.id, own.filter((_, i) => verdicts[i]!.interface));
    });
    const chromeItems = [...new Map([...textsOf.values()].flat().filter((t) => chrome.has(t.text)).map((t) => [t.text, t])).values()];
    const chromeVerdicts = await classifyUiTexts(judge, { route: "(every signed-in page)", title: "shared header and navigation", hasParams: false }, chromeItems);
    const chromeKept = chromeItems.filter((_, i) => chromeVerdicts[i]!.interface);
    const dropped = [...textsOf.values()].flat().length - [...kept.values()].flat().length - chromeItems.length;
    console.log(`[qa] texts: ${chromeKept.length} shared chrome (of ${chromeItems.length}), ${[...kept.values()].flat().length} page-specific kept, ${dropped} judged as content and not asserted`);

    // record: reachability on every node, structural assertions on the ones that loaded
    map.nodes = map.nodes.map((n) => {
      if (n.id === "node:global-nav") return withObserved(n, chromeAssertions(n.id, n.provenance.sourceFiles, chromeKept));
      const s = statusOf.get(n.id)!;
      const observed = {
        at,
        status: s.status === "ok" || s.status === "failed" ? ("reachable" as const) : s.status === "unreachable-here" ? ("unreachable-here" as const) : s.status === "untestable-no-data" ? ("untestable-no-data" as const) : ("skipped" as const),
        httpStatus: s.http,
        path: s.path,
        note: s.reason,
        errors: byId.get(n.id)?.ev.observation.consoleErrors,
        failedRequests: byId.get(n.id)?.ev.observation.failedRequests,
      };
      const r = byId.get(n.id);
      const updated = r && r.status === "ok" ? withObserved(n, observedAssertions(n, r.ev, r.v.path!, kept.get(n.id) ?? [])) : n;
      return { ...updated, observed };
    });
    store.save(map);
    store.saveArtifact("mindmap.mmd", toMermaid(map));

    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "baseline.json"),
      JSON.stringify(
        results.map((r) => ({ flow: r.v.node.id, path: r.v.path, status: r.status, reason: r.reason, observation: r.ev.observation, structure: r.ev.structure, blockedWrites: r.ev.blockedWrites, settled: r.ev.settled })),
        null,
        2,
      ) + "\n",
    );

    const counts = [...statusOf.values()].reduce<Record<string, number>>((acc, s) => ((acc[s.status] = (acc[s.status] ?? 0) + 1), acc), {});
    console.log(`[qa] ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    for (const r of results) {
      const extra = [
        r.ev.observation.consoleErrors?.length ? `${r.ev.observation.consoleErrors.length} console errors` : "",
        r.ev.observation.failedRequests?.length ? `${r.ev.observation.failedRequests.length} failed requests` : "",
        r.ev.blockedWrites.length ? `${r.ev.blockedWrites.length} writes blocked` : "",
        r.ev.settled ? "" : "not settled",
      ].filter(Boolean).join(", ");
      console.log(`    ${r.status.padEnd(17)} ${(r.v.path ?? "").padEnd(40)} ${r.ev.httpStatus ?? "-"} ${extra}`);
    }
    const assertions = map.nodes.reduce((n, x) => n + x.assertions.filter((a) => a.provenance.origin === "qa-observed").length, 0);
    console.log(`[qa] ${assertions} qa-observed assertions written to ${store.location()}`);
    const tok = usage.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0);
    console.log(`[qa] Jev: ${usage.length} requests, ${tok.toLocaleString()} tokens`);
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error("[qa] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
