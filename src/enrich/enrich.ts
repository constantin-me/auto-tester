import type { Assertion, FlowNode, MindMap } from "../mindmap/schema.js";
import { mergePreservingPins } from "../mindmap/guard.js";
import { JevCache } from "../jev/cache.js";
import { mapLimit } from "../jev/client.js";
import type { EnrichClient, EnrichRequest, Usage } from "./client.js";
import { normalize, type EnrichOutput } from "./schema.js";
import { gatherEvidence, type EnrichContext } from "./evidence.js";
import { SYSTEM_PROMPT, userPrompt } from "./prompt.js";

/**
 * LLM enrichment (PER-42): labels + natural-language expected-behavior assertions on top
 * of the static skeleton. Two phases so a dry run can report the plan without a client:
 *   plan()   evidence + prompt + cache state per node, no network
 *   enrich() sends what the cache cannot answer, writes the results into the map
 */

export interface EnrichSettings {
  model: string;
  effort: EnrichRequest["effort"];
  concurrency: number;
  /** restrict to these node ids */
  only?: Set<string>;
  /** at most this many eligible nodes (cached or not) */
  limit?: number;
}

export interface CachedAnswer {
  output: EnrichOutput;
  usage: Usage;
}

export type PlanItem =
  | { node: FlowNode; status: "skipped"; reason: string }
  | { node: FlowNode; status: "send" | "cached"; request: EnrichRequest; key: string; sourceFiles: string[]; promptChars: number };

export function cacheKey(cache: JevCache<CachedAnswer>, req: EnrichRequest): string {
  // model is mixed in by the cache itself; effort changes the answer, so it is part of the question
  return cache.key("enrich", { system: req.system, effort: req.effort }, req.user);
}

export function plan(map: MindMap, ctx: EnrichContext, cfg: EnrichSettings, cache: JevCache<CachedAnswer>): PlanItem[] {
  const items: PlanItem[] = [];
  const sharedFiles = new Set(map.nodes.filter((n) => n.kind === "synthetic").flatMap((n) => n.provenance.sourceFiles));
  ctx = { ...ctx, sharedFiles };
  let eligible = 0;
  for (const node of map.nodes) {
    if (cfg.only && !cfg.only.has(node.id)) continue;
    const ev = gatherEvidence(node, ctx);
    if (!ev.ok) {
      items.push({ node, status: "skipped", reason: ev.reason });
      continue;
    }
    if (cfg.limit !== undefined && eligible >= cfg.limit) continue;
    eligible++;
    const request: EnrichRequest = { model: cfg.model, effort: cfg.effort, system: SYSTEM_PROMPT, user: userPrompt(node, ev.text) };
    const key = cacheKey(cache, request);
    items.push({
      node,
      status: cache.has(key) ? "cached" : "send",
      request,
      key,
      sourceFiles: ev.sourceFiles,
      promptChars: request.system.length + request.user.length,
    });
  }
  return items;
}

export interface NodeResult {
  nodeId: string;
  status: "enriched" | "cached" | "skipped" | "failed";
  reason?: string;
  assertions?: number;
  /** tokens billed for this node; absent when cached or skipped */
  usage?: Usage;
}

export async function enrich(
  previous: MindMap,
  items: PlanItem[],
  client: EnrichClient,
  cache: JevCache<CachedAnswer>,
  cfg: Pick<EnrichSettings, "concurrency">,
  /** called as each node finishes, so a long run shows progress instead of silence */
  onResult?: (result: NodeResult) => void,
): Promise<{ map: MindMap; results: NodeResult[] }> {
  const answers = new Map<string, { answer: CachedAnswer; sourceFiles: string[] }>();

  const results = await mapLimit(items, cfg.concurrency, async (item) => {
    const r = await enrichOne(item);
    onResult?.(r);
    return r;
  });
  async function enrichOne(item: PlanItem): Promise<NodeResult> {
    const nodeId = item.node.id;
    if (item.status === "skipped") return { nodeId, status: "skipped", reason: item.reason };
    let billed: Usage | undefined;
    try {
      const answer = await cache.getOrAsk(item.key, async () => {
        const res = await client.enrich(item.request);
        if (!res.ok) {
          billed = res.usage;
          throw new Error(res.reason);
        }
        billed = res.usage;
        return { output: normalize(res.output), usage: res.usage };
      });
      // persist per answer: a crash later in the run must not lose answers already paid for
      if (billed) cache.save();
      answers.set(nodeId, { answer, sourceFiles: item.sourceFiles });
      return { nodeId, status: billed ? "enriched" : "cached", assertions: answer.output.assertions.length, ...(billed ? { usage: billed } : {}) };
    } catch (err) {
      return { nodeId, status: "failed", reason: err instanceof Error ? err.message : String(err), ...(billed ? { usage: billed } : {}) };
    }
  }
  cache.save();

  const next: MindMap = {
    ...previous,
    nodes: previous.nodes.map((n) => {
      const a = answers.get(n.id);
      return a ? applyOutput(n, a.answer.output, a.sourceFiles) : n;
    }),
  };
  // the guard is the last word: pinned assertions come back exactly as they were
  return { map: mergePreservingPins(previous, next), results };
}

/**
 * Replace this node's earlier `llm-author` assertions with the new ones. Pinned and
 * `qa-observed` assertions are carried over untouched; the guard re-attaches pins after.
 */
export function applyOutput(node: FlowNode, out: EnrichOutput, sourceFiles: string[]): FlowNode {
  const kept = node.assertions.filter((a) => a.pinned || a.provenance.origin !== "llm-author");
  const taken = new Set(kept.filter((a) => !a.pinned).map((a) => a.id));
  const confidence = Math.min(out.confidence, 0.9); // model-authored: never as trusted as a human
  const generated: Assertion[] = [];
  const used = new Set<string>();
  for (const a of out.assertions) {
    const base = `llm:${node.id}:${slugify(a.slug || a.expectation)}`;
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    if (taken.has(id)) continue;
    generated.push({
      id,
      expectation: a.expectation,
      ...(a.check ? { check: a.check } : {}),
      severityIfBroken: a.severityIfBroken,
      pinned: false,
      provenance: { sourceFiles, origin: "llm-author", confidence },
    });
  }
  return {
    ...node,
    // a human-authored node keeps its name
    label: node.provenance.origin === "human" || !out.label ? node.label : out.label,
    assertions: [...kept, ...generated],
  };
}

function slugify(s: string): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "");
  return slug || "assertion";
}
