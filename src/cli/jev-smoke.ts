import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { detectCandidates } from "../detect/impact.js";
import { viewIndexFor } from "../bootstrap/crawl.js";
import type { ViewIndex } from "../bootstrap/ejs.js";
import { loadConfig } from "../config/config.js";
import { makeStore } from "../store/store.js";
import { readCommit } from "../diff/git.js";
import { Judge, mapLimit, type UsageRecord } from "../jev/client.js";
import { triageFlow, type FlowContext } from "../jev/judgments.js";
import type { FlowNode, MindMap } from "../mindmap/schema.js";

/**
 * Live Jev smoke test against a real commit of the target app.
 * Usage: npm run jev:smoke -- <config> <commit>
 *   e.g. npm run jev:smoke -- examples/dvinyl.config.json c44995f
 *
 * Triage runs on flows the static map links to the changed files, plus a few
 * unrelated control flows that Jev should mark as NOT affected.
 */
async function main() {
  const args = process.argv.slice(2);
  const detectOnly = args.includes("--detect-only");
  const [configArg, rev] = args.filter((a) => !a.startsWith("--"));
  if (!configArg || !rev || !existsSync(configArg)) {
    console.error("usage: npm run jev:smoke -- <path-to-config.json> <commit> [--detect-only]");
    process.exit(2);
  }
  const { config, baseDir } = loadConfig(configArg);
  const appRoot = resolve(baseDir, config.appRoot);
  const map = makeStore(config.store.backend, baseDir, config.store.dir).load(config.repo);
  if (!map.nodes.length) {
    console.error("[jev-smoke] mind-map is empty; run bootstrap first.");
    process.exit(2);
  }

  const change = readCommit(appRoot, rev);
  const changed = change.files.map((f) => f.path);
  console.log(`[jev-smoke] ${rev}: ${change.summary.split("\n")[0]}`);
  console.log(`[jev-smoke] changed: ${changed.join(", ")}`);

  const detection = detectCandidates(appRoot, map, change, `${rev}~1`, config.crawler);
  console.log(`[jev-smoke] detector: ${detection.candidates.length} candidate flows, ${detection.unmapped.length} unmapped hunks`);
  for (const c of detection.candidates) console.log(`    ${c.nodeId}\n        ${c.reasons.join("\n        ")}`);
  for (const u of detection.unmapped) console.log(`    unmapped ${u.file} ${u.header}  (${u.why})`);
  if (detectOnly) return;

  const usage: UsageRecord[] = [];
  let judge: Judge;
  try {
    judge = new Judge({ model: config.jev.model, onUsage: (u) => usage.push(u) });
  } catch (err) {
    console.error(`[jev-smoke] ${(err as Error).message}`);
    process.exit(2);
  }

  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const candidateIds = new Set(detection.candidates.map((c) => c.nodeId));
  const controlRoutes = ["/login", "/settings", "/admin/instance", "/backup/export"];
  const controls = map.nodes.filter((n) => !candidateIds.has(n.id) && controlRoutes.includes(n.route ?? "")).slice(0, 3);
  const flows = [
    ...detection.candidates.map((c) => ({ n: byId.get(c.nodeId)!, group: "candidate", focus: { reasons: c.reasons, hunks: c.hunks } })),
    ...controls.map((n) => ({ n, group: "control", focus: undefined })),
  ];
  console.log(`[jev-smoke] judging ${detection.candidates.length} candidates + ${controls.length} controls`);

  const views = viewIndexFor(appRoot, config.crawler);
  const started = Date.now();
  const results = await mapLimit(flows, config.jev.concurrency, async ({ n, focus }) =>
    triageFlow(judge, change, contextFor(map, n, views), undefined, focus),
  );
  const ms = Date.now() - started;

  console.log("");
  console.log(pad("group", 11) + pad("flow", 30) + pad("P(runs)", 9) + pad("P(alter)", 9) + pad("P(refac)", 9) + pad("impact", 8) + pad("crit", 6) + pad("value", 7) + "affected  escalate");
  flows.forEach(({ n, group }, i) => {
    const t = results[i]!;
    console.log(
      pad(group, 11) +
        pad(n.route ?? n.id, 30) +
        pad(t.pRuns.toFixed(2), 9) +
        pad(t.pAlters.toFixed(2), 9) +
        pad(t.pPreserving.toFixed(2), 9) +
        pad(t.impact.toFixed(2), 8) +
        pad(t.criticality.toFixed(1), 6) +
        pad(t.value.toFixed(2), 7) +
        pad(t.affected ? "YES" : "no", 10) +
        (t.escalate ? "yes" : ""),
    );
  });
  const inTok = usage.reduce((s, u) => s + u.inputTokens, 0);
  const outTok = usage.reduce((s, u) => s + u.outputTokens, 0);
  console.log("");
  console.log(`[jev-smoke] ${usage.length} requests, ${inTok} input + ${outTok} output tokens, ${ms} ms wall, model=${usage[0]?.model}`);
}

function contextFor(map: MindMap, node: FlowNode, views: ViewIndex): FlowContext {
  return { node, edges: map.edges.filter((e) => e.from === node.id), templates: node.view ? views.chain(node.view) : [] };
}

const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w - 1) + " " : s + " ".repeat(w - s.length));

main().catch((err) => {
  console.error("[jev-smoke] failed:", err);
  process.exit(1);
});
