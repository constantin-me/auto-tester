import type { FlowNode } from "../mindmap/schema.js";
import { planComparison } from "../compare/compare.js";

/**
 * Best-first visit order (PER-49). The ledger stops new visits in list order once the cap is
 * reached, so the order IS the spending policy: highest value per unit of cost first.
 *
 * Value comes from Jev triage (impact, criticality, refactor discount). Cost is estimated in
 * code, not asked of Jev: what a visit can spend is known from the map, and asking would
 * itself cost a request per flow.
 *
 * Cost units, one per Jev request a clean visit makes, plus one for the visit itself (browser
 * time, and the severity rating any finding needs):
 *   - when anything held at baseline, the page's assertions without a machine check are
 *     re-asked (the same set baseline asked, so it can come from cache): one request per 40
 *   - everything else (selectors, text, url, status) is decided in code for free
 * Retries and severity ratings only happen when something deviates, so they are not counted.
 */
const JEV_CHUNK = 40;

export function visitCost(node: FlowNode): number {
  const { all, armed } = planComparison(node);
  if (!armed.length) return 1;
  const needJev = all.filter((a) => !a.check || a.check.kind === "custom").length;
  return 1 + Math.ceil(needJev / JEV_CHUNK);
}

/** Highest value per cost first; ties keep their earlier (triage value) order. */
export function bestFirst<T>(items: T[], value: (item: T) => number, node: (item: T) => FlowNode): T[] {
  return items
    .map((item, i) => ({ item, i, score: value(item) / visitCost(node(item)) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.item);
}
