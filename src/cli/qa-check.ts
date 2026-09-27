import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/config.js";
import { makeStore } from "../store/store.js";
import { readCommit, readRange, readWorkingTree } from "../diff/git.js";
import { detectCandidates, isDirect } from "../detect/impact.js";
import { viewIndexFor } from "../bootstrap/crawl.js";
import { Judge, mapLimit, type UsageRecord } from "../jev/client.js";
import { askExecution, askTriage, decideTriage, dropByExecution, type FlowContext } from "../jev/judgments.js";
import { executionState } from "../jev/evidence.js";
import { DEFAULT_POLICY } from "../jev/policy.js";
import { QaSession } from "../qa/driver.js";
import { planVisits } from "../qa/plan.js";
import { checkFlow, type FlowCheck } from "../qa/check.js";
import { buildReport, type NotVisited } from "../report/build.js";
import { renderMarkdown } from "../report/markdown.js";

/**
 * M4 slice 2: check a change against the baseline, in a real browser, read-only.
 *
 *   npm run qa:check -- <config> --working-tree     uncommitted changes of the app
 *   npm run qa:check -- <config> <commit>
 *   npm run qa:check -- <config> <base>..<head>
 *
 * detect -> Jev triage (+ execution check for indirect links) -> visit the affected
 * flows -> compare with the baseline -> Jev judges misses and rates severity.
 */
async function main() {
  const argv = process.argv.slice(2);
  // --no-exec: skip the execution check (PER-69), e.g. to compare how many flows it saves
  const useExec = !argv.includes("--no-exec");
  const [configArg, target] = argv.filter((a) => a !== "--no-exec");
  if (!configArg || !target || !existsSync(configArg)) {
    console.error("usage: npm run qa:check -- <config> (--working-tree | <commit> | <base>..<head>) [--no-exec]");
    process.exit(2);
  }
  const { config, baseDir } = loadConfig(configArg);
  if (!config.env.baseUrl) throw new Error("config.env.baseUrl is required for QA runs");
  const appRoot = resolve(baseDir, config.appRoot);
  const store = makeStore(config.store.backend, baseDir, config.store.dir);
  const map = store.load(config.repo);
  if (!map.nodes.some((n) => n.observed)) throw new Error("no baseline in the mind-map; run npm run qa:baseline first");

  const [change, baseRev] =
    target === "--working-tree"
      ? [readWorkingTree(appRoot), "HEAD"]
      : target.includes("..")
        ? [readRange(appRoot, target.split("..")[0]!, target.split("..")[1]!), target.split("..")[0]!]
        : [readCommit(appRoot, target), `${target}~1`];
  if (!change.files.length) {
    console.log("[qa] no changes to check");
    return;
  }
  const at = new Date().toISOString();
  const runDir = resolve(baseDir, config.qa.runsDir, `check-${at.replace(/[:.]/g, "-")}`);
  console.log(`[qa] checking ${target}: ${change.files.map((f) => f.path).join(", ")}`);

  // ---- which flows are affected --------------------------------------------------
  const usage: UsageRecord[] = [];
  const judge = new Judge({ model: config.jev.model, onUsage: (u) => usage.push(u) });
  const detection = detectCandidates(appRoot, map, change, baseRev, config.crawler);
  const views = viewIndexFor(appRoot, config.crawler);
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const judged = await mapLimit(detection.candidates, config.jev.concurrency, async (k) => {
    const node = byId.get(k.nodeId)!;
    const flow: FlowContext = {
      node,
      edges: map.edges.filter((e) => e.from === k.nodeId),
      templates: views.chainAll(node.views.length ? node.views : node.view ? [node.view] : []),
    };
    const triage = decideTriage(await askTriage(judge, change, flow, { reasons: k.reasons, hunks: k.hunks }), DEFAULT_POLICY);
    let pDiffers: number | undefined;
    if (useExec && triage.affected && k.links.every((l) => !isDirect(l))) pDiffers = await askExecution(judge, executionState(node, k, { appRoot, views }));
    const affected = triage.affected && !(pDiffers !== undefined && dropByExecution(pDiffers, k.links, DEFAULT_POLICY));
    return { k, node, triage, pDiffers, affected };
  });
  const affected = judged.filter((j) => j.affected).sort((a, b) => b.triage.value - a.triage.value);
  console.log(`[qa] ${detection.candidates.length} candidates -> ${affected.length} affected after Jev (execution check ${useExec ? "on" : "off"})`);
  for (const j of judged.filter((x) => !x.affected)) console.log(`    not tested  ${j.node.route ?? j.node.id}  (Jev: P(runs)=${j.triage.pRuns.toFixed(2)}${j.pDiffers !== undefined ? `, P(differs)=${j.pDiffers.toFixed(2)}` : ""})`);

  // ---- visit and compare -----------------------------------------------------------
  const session = await QaSession.open({ baseUrl: config.env.baseUrl, auth: config.auth, allowWrites: config.qa.allowWrites });
  const results: (FlowCheck | NotVisited)[] = [];
  try {
    const links = await session.harvestLinks(config.qa.seedPaths);
    const plan = planVisits(
      affected.map((a) => a.node),
      links,
      config.qa,
    );
    for (const p of plan.filter((x) => !x.path)) results.push({ flow: p.node.id, status: p.status!, reason: p.reason ?? "" });
    const visits = plan.filter((p) => p.path && p.node.observed?.status !== "unreachable-here");
    for (const p of plan.filter((x) => x.path && x.node.observed?.status === "unreachable-here")) {
      results.push({ flow: p.node.id, path: p.path, status: "unreachable-here", reason: "404 at baseline too (module disabled here)" });
    }
    const checks = await mapLimit(visits, config.qa.concurrency, (p) =>
      checkFlow(session, p.node, p.path!, judge, { retryCount: config.flakiness.retryCount, evidenceDir: runDir }),
    );
    results.push(...checks);
  } finally {
    await session.close();
  }

  // ---- report ----------------------------------------------------------------------
  mkdirSync(runDir, { recursive: true });
  const report = buildReport({
    repo: config.repo,
    target,
    generatedAt: at,
    changedFiles: change.files.map((f) => f.path),
    judged: judged.map((j) => ({ node: j.node, reasons: j.k.reasons, files: j.k.files, triage: j.triage, pDiffers: j.pDiffers, affected: j.affected })),
    results,
    executionCheck: useExec,
    dropBelow: DEFAULT_POLICY.execution.dropBelow,
    usage,
    evidenceDir: runDir,
  });
  const markdown = renderMarkdown(report);
  writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(runDir, "report.md"), markdown);
  console.log("");
  console.log(markdown);
  console.log(`[qa] report -> ${join(runDir, "report.md")} (and report.json)`);
  // advisory: the exit code only lets callers know; nothing here blocks a merge
  if (report.verdict === "likely-regression") process.exitCode = 1;
}

main().catch((err) => {
  console.error("[qa] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
