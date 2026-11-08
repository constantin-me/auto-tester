import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/config.js";
import { makeStore } from "../store/store.js";
import { viewIndexFor } from "../bootstrap/crawl.js";
import { extractRoutes, findEntry } from "../bootstrap/express.js";
import { JevCache } from "../jev/cache.js";
import { toMermaid } from "../mindmap/mermaid.js";
import { anthropicClient } from "../enrich/client.js";
import { claudeCodeClient } from "../enrich/claude-code.js";
import { enrich, plan, type CachedAnswer } from "../enrich/enrich.js";

/**
 * PER-42: LLM enrichment pass over the static mind-map.
 * Usage: npm run enrich -- <config> [--dry-run] [--only <nodeId,...>] [--limit N]
 *
 * --dry-run makes no API call and needs no key: it reports what a real run would send.
 * Prompts and the API key are never logged, only sizes.
 */

// rough list price for the default model, per million tokens; the dry run is an estimate only
const USD_PER_M_INPUT = 4;
const USD_PER_M_OUTPUT = 20;
const EST_OUTPUT_TOKENS_PER_NODE = 600;

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const only = flag("--only");
  const limitRaw = flag("--limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    console.error("[enrich] --limit needs a positive integer");
    process.exit(2);
  }
  const valueArgs = new Set([only, limitRaw]);
  const configArg = argv.find((a) => !a.startsWith("--") && !valueArgs.has(a));
  if (!configArg || !existsSync(configArg)) {
    console.error("usage: npm run enrich -- <path-to-config.json> [--dry-run] [--only <nodeId,...>] [--limit N]");
    process.exit(2);
  }

  const { config, baseDir } = loadConfig(configArg);
  const appRoot = resolve(baseDir, config.appRoot);
  const store = makeStore(config.store.backend, baseDir, config.store.dir);
  const previous = store.load(config.repo);
  if (!previous.nodes.length) {
    console.error("[enrich] mind-map is empty; run bootstrap first.");
    process.exit(2);
  }
  const cfg = config.enrich;
  const cache = new JevCache<CachedAnswer>(join(resolve(baseDir, config.qa.runsDir, "..", "cache"), "enrich.json"), cfg.model);

  const entry = findEntry(appRoot, config.crawler.entry);
  const items = plan(
    previous,
    {
      appRoot,
      routes: extractRoutes(appRoot, entry, config.crawler.expansions),
      views: viewIndexFor(appRoot, config.crawler),
      edges: previous.edges,
      maxEvidenceChars: cfg.maxEvidenceChars,
    },
    { model: cfg.model, effort: cfg.effort, concurrency: cfg.concurrency, ...(only ? { only: new Set(only.split(",")) } : {}), ...(limit ? { limit } : {}) },
    cache,
  );

  const toSend = items.flatMap((i) => (i.status === "send" ? [i] : []));
  const cached = items.filter((i) => i.status === "cached").length;
  const skipped = items.flatMap((i) => (i.status === "skipped" ? [i] : []));
  const bySkip = new Map<string, number>();
  for (const s of skipped) bySkip.set(s.reason.split(":")[0]!, (bySkip.get(s.reason.split(":")[0]!) ?? 0) + 1);

  console.log(`[enrich] repo=${config.repo} backend=${cfg.backend} model=${cfg.model} effort=${cfg.effort}`);
  console.log(
    `[enrich] nodes=${previous.nodes.length} considered=${items.length} to-send=${toSend.length} cached=${cached} ` +
      `skipped=${skipped.length}${skipped.length ? ` (${[...bySkip].map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}`,
  );
  for (const s of skipped) if (s.reason.startsWith("skipped-too-large")) console.log(`    ${s.node.id}: ${s.reason}`);

  if (dryRun) {
    const chars = toSend.reduce((s, i) => s + i.promptChars, 0);
    const inTok = Math.round(chars / 4);
    const outTok = toSend.length * EST_OUTPUT_TOKENS_PER_NODE;
    const usd = (inTok * USD_PER_M_INPUT + outTok * USD_PER_M_OUTPUT) / 1e6;
    console.log(`[enrich] dry run: no API call made`);
    console.log(`[enrich] ESTIMATE input tokens ~${inTok.toLocaleString("en-US")} (chars/4 over ${chars.toLocaleString("en-US")} chars)`);
    if (cfg.backend === "claude-code") {
      console.log(`[enrich] backend claude-code: counts against your Claude subscription's usage limits (API list price would be ~$${usd.toFixed(2)})`);
      return;
    }
    console.log(
      `[enrich] ESTIMATE cost ~$${usd.toFixed(2)} ` +
        `(input $${USD_PER_M_INPUT}/M, output $${USD_PER_M_OUTPUT}/M, assuming ~${EST_OUTPUT_TOKENS_PER_NODE} output tokens/node = ${outTok.toLocaleString("en-US")})`,
    );
    return;
  }

  if (cfg.backend === "api" && !process.env.ANTHROPIC_API_KEY) {
    console.error('[enrich] ANTHROPIC_API_KEY is not set (put it in .env), or set enrich.backend to "claude-code" to use your Claude subscription locally.');
    process.exit(2);
  }
  const client = cfg.backend === "claude-code" ? claudeCodeClient() : anthropicClient();
  // one line per node as it finishes: a full run takes minutes, and silence looks like a hang
  const total = toSend.length + cached;
  let done = 0;
  if (toSend.length) console.log(`[enrich] sending ${toSend.length} pages, ${cfg.concurrency} at a time (answers are saved as they arrive; an interrupted run resumes for free)`);
  const { map, results } = await enrich(previous, items, client, cache, cfg, (r) => {
    if (r.status === "skipped") return;
    const tokens = r.usage ? ` in=${r.usage.inputTokens} out=${r.usage.outputTokens}` : "";
    console.log(`  [${++done}/${total}] ${r.nodeId}: ${r.status}${r.assertions !== undefined ? ` assertions=${r.assertions}` : ""}${tokens}${r.reason ? `  (${r.reason})` : ""}`);
  });

  let inTok = 0;
  let outTok = 0;
  for (const r of results) {
    if (r.usage) {
      inTok += r.usage.inputTokens;
      outTok += r.usage.outputTokens;
    }
  }
  const failed = results.filter((r) => r.status === "failed").length;
  console.log(`[enrich] enriched=${results.filter((r) => r.status === "enriched").length} cached=${results.filter((r) => r.status === "cached").length} failed=${failed}`);
  const usd = ((inTok * USD_PER_M_INPUT + outTok * USD_PER_M_OUTPUT) / 1e6).toFixed(2);
  console.log(`[enrich] usage: input=${inTok} output=${outTok} tokens (~$${usd}${cfg.backend === "claude-code" ? " at API list price; billed to your subscription" : ""})`);

  // nothing applied (all failed / skipped): leave the map alone, a timestamp-only rewrite is noise in the PR diff
  if (results.some((r) => r.status === "enriched" || r.status === "cached")) {
    store.save({ ...map, generatedAt: new Date().toISOString() });
    store.saveArtifact("mindmap.mmd", toMermaid(map));
    console.log(`[enrich] wrote ${store.location()}`);
    console.log(`[enrich] review the diff, then pin the load-bearing assertions (pinned: true).`);
  } else {
    console.log(`[enrich] nothing enriched; mind-map left unchanged`);
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[enrich] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
