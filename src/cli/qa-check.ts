import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/config.js";
import { makeStore } from "../store/store.js";
import { readCommit, readRange, readWorkingTree } from "../diff/git.js";
import { detectCandidates, isDirect } from "../detect/impact.js";
import { viewIndexFor } from "../bootstrap/crawl.js";
import { Judge, type UsageRecord } from "../jev/client.js";
import {
  askExecution,
  askTriage,
  decideTriage,
  dropByExecution,
  EXECUTION_QUESTIONS,
  triageState,
  TRIAGE_QUESTIONS,
  type FlowContext,
  type TriageRaw,
} from "../jev/judgments.js";
import { JevCache } from "../jev/cache.js";
import { executionState } from "../jev/evidence.js";
import { DEFAULT_POLICY } from "../jev/policy.js";
import { QaSession } from "../qa/driver.js";
import { loginBlocked, openWithRetry } from "../qa/login-gate.js";
import type { FlowNode } from "../mindmap/schema.js";
import { planVisits } from "../qa/plan.js";
import { checkFlow, type FlowCheck } from "../qa/check.js";
import type { AssertionCache } from "../compare/compare.js";
import { buildReport, BUDGET_NOT_VISITED, type NotVisited } from "../report/build.js";
import { renderMarkdown } from "../report/markdown.js";
import { BudgetLedger, mapGated } from "../budget/ledger.js";
import { bestFirst } from "../budget/schedule.js";

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
  // --no-cache: ask Jev again even when an identical question was answered before
  const useCache = !argv.includes("--no-cache");
  const [configArg, target] = argv.filter((a) => a !== "--no-exec" && a !== "--no-cache");
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
  // every Jev call is debited; past the cap nothing new starts, running work finishes (see budget/ledger.ts)
  const ledger = new BudgetLedger(config.budget.maxTokens, config.budget.reserveForChecks);
  const judge = new Judge({
    model: config.jev.model,
    onUsage: (u) => {
      usage.push(u);
      ledger.debit(u);
    },
  });
  // same change, same question, same state, same model -> same answer, free (--no-cache to re-ask)
  const cacheDir = resolve(baseDir, config.qa.runsDir, "..", "cache");
  const model = config.jev.model ?? "sdk-default";
  const triageCache = new JevCache<TriageRaw>(useCache ? join(cacheDir, "triage.json") : null, model);
  const execCache = new JevCache<number>(useCache ? join(cacheDir, "execution.json") : null, model);
  // the comparison step too: severity decides the verdict, so it must not flip between runs
  const observationCache = new JevCache<{ pSufficient: number; pHolds: number }>(useCache ? join(cacheDir, "observation.json") : null, model);
  const severityCache = new JevCache<{ score: number; confidence: number }>(useCache ? join(cacheDir, "severity.json") : null, model);
  const assertionCache: AssertionCache = new JevCache(useCache ? join(cacheDir, "assertions.json") : null, model);
  const detection = detectCandidates(appRoot, map, change, baseRev, config.crawler);
  const views = viewIndexFor(appRoot, config.crawler);
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  // direct links first: cheap, high-confidence flows are judged before the indirect fan-out,
  // so a cap that bites cuts the least valuable candidates (stable sort keeps detection order)
  const ordered = [...detection.candidates].sort((a, b) => Number(b.links.some(isDirect)) - Number(a.links.some(isDirect)));
  const prepared = ordered.map((k) => {
    const node = byId.get(k.nodeId)!;
    const flow: FlowContext = {
      node,
      edges: map.edges.filter((e) => e.from === k.nodeId),
      templates: views.chainAll(node.views.length ? node.views : node.view ? [node.view] : []),
    };
    const focus = { reasons: k.reasons, hunks: k.hunks };
    const triageKey = triageCache.key("triage", TRIAGE_QUESTIONS, triageState(change, flow, focus));
    return { k, node, flow, focus, triageKey };
  });
  // triage + execution may only spend up to the reserve line; a cached answer is free, so it always runs
  const gatedJudged = await mapGated(
    prepared,
    config.jev.concurrency,
    ledger,
    "triage",
    async ({ k, node, flow, focus, triageKey }) => {
      const raw = await triageCache.getOrAsk(triageKey, () => askTriage(judge, change, flow, focus));
      const triage = decideTriage(raw, DEFAULT_POLICY);
      let pDiffers: number | undefined;
      if (useExec && triage.affected && k.links.every((l) => !isDirect(l))) {
        const state = executionState(node, k, { appRoot, views });
        const execKey = execCache.key("execution", EXECUTION_QUESTIONS, state);
        // the execution check only ever drops a flow; if the budget cannot pay for it the flow
        // stays affected (visited) rather than being silently lost
        if (ledger.mayStart("triage") || execCache.has(execKey)) {
          pDiffers = await execCache.getOrAsk(execKey, () => askExecution(judge, state));
        }
      }
      const affected = triage.affected && !(pDiffers !== undefined && dropByExecution(pDiffers, k.links, DEFAULT_POLICY));
      return { k, node, triage, pDiffers, affected };
    },
    (p) => triageCache.has(p.triageKey),
  );
  const judged = gatedJudged.flatMap((g) => (g.started ? [g.value] : []));
  const untriaged = prepared.filter((_, i) => !gatedJudged[i]!.started).map((p) => ({ node: p.node, reasons: p.k.reasons, files: p.k.files }));
  if (untriaged.length) console.log(`[qa] token cap reached during triage: ${untriaged.length} candidates not judged`);
  if (useCache) {
    triageCache.save();
    execCache.save();
  }
  console.log(`[qa] Jev cache: ${triageCache.hits + execCache.hits} answers reused, ${triageCache.misses + execCache.misses} asked${useCache ? "" : " (--no-cache)"}`);
  const affected = judged.filter((j) => j.affected).sort((a, b) => b.triage.value - a.triage.value);
  console.log(`[qa] ${detection.candidates.length} candidates -> ${affected.length} affected after Jev (execution check ${useExec ? "on" : "off"})`);
  for (const j of judged.filter((x) => !x.affected)) console.log(`    not tested  ${j.node.route ?? j.node.id}  (Jev: P(runs)=${j.triage.pRuns.toFixed(2)}${j.pDiffers !== undefined ? `, P(differs)=${j.pDiffers.toFixed(2)}` : ""})`);

  // ---- visit and compare -----------------------------------------------------------
  const results: (FlowCheck | NotVisited)[] = [];
  // a change that breaks login is reported, not a crash (see qa/login-gate.ts)
  const baseUrl = config.env.baseUrl;
  const opened = await openWithRetry(() =>
    QaSession.open({ baseUrl, auth: config.auth, allowWrites: config.qa.allowWrites, launchArgs: config.qa.launchArgs }),
  );
  const session = opened.session;
  let gate: { node?: FlowNode; check: FlowCheck } | undefined;
  if (!session) {
    const blocked = loginBlocked(opened.failures, affected.map((a) => a.node), config.auth.loginPath ?? "/login", map.nodes);
    console.log(`[qa] ${blocked.gate.findings[0]!.actual} (${opened.failures.length} attempts); reporting it instead of visiting`);
    results.push(...blocked.notVisited, blocked.gate);
    gate = { node: blocked.gateNode, check: blocked.gate };
  } else try {
    const links = await session.harvestLinks(config.qa.seedPaths, { depth: config.qa.harvestDepth, deny: config.qa.denyPaths });
    const plan = planVisits(
      affected.map((a) => a.node),
      links,
      config.qa,
    );
    for (const p of plan.filter((x) => !x.path)) results.push({ flow: p.node.id, status: p.status!, reason: p.reason ?? "" });
    // best-first (PER-49): the ledger stops visits in this order, so the cap cuts the least value per cost
    const valueOf = new Map(affected.map((a) => [a.node.id, a.triage.value]));
    const visits = bestFirst(
      plan.filter((p) => p.path && p.node.observed?.status !== "unreachable-here"),
      (p) => valueOf.get(p.node.id) ?? 0,
      (p) => p.node,
    );
    for (const p of plan.filter((x) => x.path && x.node.observed?.status === "unreachable-here")) {
      results.push({ flow: p.node.id, path: p.path, status: "unreachable-here", reason: "404 at baseline too (module disabled here)" });
    }
    // checked when a visit is about to start; a started flow always runs to the end
    const checks = await mapGated(visits, config.qa.concurrency, ledger, "check", (p) =>
      checkFlow(session, p.node, p.path!, judge, {
        retryCount: config.flakiness.retryCount,
        evidenceDir: runDir,
        caches: { observation: observationCache, severity: severityCache, assertions: assertionCache },
      }),
    );
    checks.forEach((c, i) => {
      const p = visits[i]!;
      if (c.started) results.push(c.value);
      else results.push({ flow: p.node.id, path: p.path, status: "skipped-budget", reason: BUDGET_NOT_VISITED });
    });
  } finally {
    await session.close();
    if (useCache) {
      observationCache.save();
      severityCache.save();
      assertionCache.save();
    }
  }

  // ---- report ----------------------------------------------------------------------
  mkdirSync(runDir, { recursive: true });
  const report = buildReport({
    repo: config.repo,
    target,
    generatedAt: at,
    changedFiles: change.files.map((f) => f.path),
    untriaged,
    gate,
    budget: { cap: ledger.cap, spent: ledger.spent, reserveForChecks: ledger.reserveForChecks },
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
