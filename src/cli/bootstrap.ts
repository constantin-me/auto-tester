import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "../config/config.js";
import { makeStore } from "../store/store.js";
import { staticCrawl } from "../bootstrap/crawl.js";
import { mergePreservingPins } from "../mindmap/guard.js";
import { toMermaid } from "../mindmap/mermaid.js";

/**
 * M1 bootstrap: seed (or re-seed) the mind-map from the target app's code.
 * Usage: npm run bootstrap -- <path-to-autotester.config.json>
 *
 * Deterministic today (static crawl). Human-pinned assertions from any existing
 * map are preserved. LLM enrichment is a later pass on top of this skeleton.
 */
async function main() {
  const configArg = process.argv[2];
  if (!configArg) {
    console.error("[bootstrap] no config path given.");
    console.error("  usage: npm run bootstrap -- <path-to-autotester.config.json>");
    console.error("  example: npm run bootstrap -- examples/dvinyl.config.json");
    process.exit(2);
  }
  if (!existsSync(configArg)) {
    console.error(`[bootstrap] config not found: ${configArg}`);
    console.error("  example: npm run bootstrap -- examples/dvinyl.config.json");
    process.exit(2);
  }
  const { config, baseDir } = loadConfig(configArg);

  const appRoot = resolve(baseDir, config.appRoot);
  const store = makeStore(config.store.backend, baseDir, config.store.dir);

  console.log(`[bootstrap] repo=${config.repo} framework=${config.framework}`);
  console.log(`[bootstrap] scanning ${appRoot}`);

  const { map: fresh, unresolved, stats } = staticCrawl(appRoot, config.repo, config.crawler);
  const previous = store.load(config.repo);
  const merged = mergePreservingPins(previous, fresh);

  const pinned = countPinned(merged);
  store.save(merged);
  const diagram = store.saveArtifact("mindmap.mmd", toMermaid(merged));

  const edgeKinds = Object.entries(
    merged.edges.reduce<Record<string, number>>((acc, e) => ((acc[e.kind] = (acc[e.kind] ?? 0) + 1), acc), {}),
  )
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(
    `[bootstrap] routes=${stats.routes} pages=${stats.pages} endpoints=${stats.endpoints} ` +
      `view-links=${stats.links} resolved=${stats.resolvedLinks}`,
  );
  console.log(`[bootstrap] nodes=${merged.nodes.length} edges=${merged.edges.length} (${edgeKinds}) pinned-assertions=${pinned}`);
  if (unresolved.length) {
    const uniq = [...new Set(unresolved.map((l) => `${l.kind} ${l.method.toUpperCase()} ${l.path}  (${l.file})`))];
    console.log(`[bootstrap] ${uniq.length} unresolved view links (no matching route):`);
    for (const u of uniq) console.log(`    ${u}`);
  }
  console.log(`[bootstrap] wrote ${store.location()}`);
  console.log(`[bootstrap] wrote ${diagram}`);
  console.log(`[bootstrap] review the diff, then pin the load-bearing assertions (pinned: true).`);
}

function countPinned(map: { nodes: any[]; edges: any[] }): number {
  const n = map.nodes.reduce((s, x) => s + x.assertions.filter((a: any) => a.pinned).length, 0);
  const e = map.edges.reduce((s, x) => s + x.assertions.filter((a: any) => a.pinned).length, 0);
  return n + e;
}

main().catch((err) => {
  console.error("[bootstrap] failed:", err);
  process.exit(1);
});
