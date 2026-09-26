import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_DIR, loadSpec, mapStore, treeDir } from "../eval/trees.js";
import { score, dedupeByTemplate, summarize, type FlowRow, type LabelConfidence, type Metrics } from "../eval/score.js";
import { detectCandidates } from "../detect/impact.js";
import { loadBindings } from "../bootstrap/express.js";
import { viewIndexFor } from "../bootstrap/crawl.js";
import { readCommit } from "../diff/git.js";
import { Judge, mapLimit, type UsageRecord } from "../jev/client.js";
import { askTriage, decideTriage, triageState, TRIAGE_QUESTIONS, type FlowContext, type TriageRaw } from "../jev/judgments.js";
import { DEFAULT_POLICY, type Policy } from "../jev/policy.js";

/**
 * Evaluate detection + triage against the labelled commits.
 *
 *   npm run eval                      detector + cached Jev answers, no tokens spent
 *   npm run eval -- --live            also ask Jev for candidates without a valid cached answer
 *   npm run eval -- --policy p.json   score cached answers under another policy
 *
 * A cached answer is valid only for the exact question set AND the exact state that
 * was sent: changing either (a question's wording, what flowState includes, the
 * hunks) invalidates it instead of silently scoring stale answers.
 *
 * Splits: train (tuned on), dev (looked at while designing), heldout (labelled blind,
 * scored after the design was frozen). Only heldout numbers are unbiased.
 */

const TOKENS_PER_REQUEST_ESTIMATE = 1600; // measured: 111,666 tokens over 69 triage requests

interface Labels {
  reviewed: boolean;
  affected: { flow: string; confidence: LabelConfidence }[];
}
type Cache = { entries: Record<string, { key: string; raw: TriageRaw }> };

const args = process.argv.slice(2);
const live = args.includes("--live");
const policyPath = args.includes("--policy") ? args[args.indexOf("--policy") + 1] : undefined;
const policy: Policy = policyPath ? JSON.parse(readFileSync(policyPath, "utf8")) : DEFAULT_POLICY;
const QUESTIONS_JSON = JSON.stringify(TRIAGE_QUESTIONS);
const QUESTIONS_HASH = createHash("sha256").update(QUESTIONS_JSON).digest("hex").slice(0, 12);
const cacheKey = (state: unknown) => createHash("sha256").update(QUESTIONS_JSON).update(JSON.stringify(state)).digest("hex");

async function main() {
  const spec = loadSpec();
  const rows: FlowRow[] = [];
  const raws: { row: FlowRow; raw: TriageRaw }[] = [];
  const usage: UsageRecord[] = [];
  let allReviewed = true;
  const notes: string[] = [];

  // detection first, for every commit: free, and gives the live token estimate
  const work = spec.commits.map((c) => {
    if (!existsSync(join(treeDir(c.sha), ".extracted"))) throw new Error(`no parent tree for ${c.sha}; run npm run eval:prepare`);
    const labels: Labels = JSON.parse(readFileSync(join(EVAL_DIR, "labels", `${c.sha}.json`), "utf8"));
    allReviewed &&= labels.reviewed;
    const map = mapStore(c.sha).load(spec.repo);
    const change = readCommit(spec.appRoot, c.sha);
    const detection = detectCandidates(treeDir(c.sha), map, change, null, spec.config.crawler);
    if (detection.dropped.length) notes.push(`${c.sha}: ${detection.dropped.length} hits dropped (not in map): ${detection.dropped.join(", ")}`);
    for (const u of detection.unmapped) notes.push(`${c.sha}: unmapped ${u.file} ${u.header.slice(0, 40)}… (${u.why})`);

    const views = viewIndexFor(treeDir(c.sha), spec.config.crawler);
    const byId = new Map(map.nodes.map((n) => [n.id, n]));
    const requests = detection.candidates.map((k) => {
      const node = byId.get(k.nodeId)!;
      const flow: FlowContext = {
        node,
        edges: map.edges.filter((e) => e.from === k.nodeId),
        templates: node.view ? views.chain(node.view) : [],
      };
      const focus = { reasons: k.reasons, hunks: k.hunks };
      return { nodeId: k.nodeId, flow, focus, key: cacheKey(triageState(change, flow, focus)) };
    });

    const cacheFile = join(EVAL_DIR, ".cache", "jev", `${c.sha}.json`);
    const loaded = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
    const cache: Cache = { entries: loaded.entries && !("questions" in loaded) ? loaded.entries : {} };
    return { c, labels, map, change, detection, requests, cacheFile, cache };
  });

  const valid = (w: (typeof work)[number], r: (typeof work)[number]["requests"][number]) => w.cache.entries[r.nodeId]?.key === r.key;
  const missing = work.reduce((n, w) => n + w.requests.filter((r) => !valid(w, r)).length, 0);
  console.log(`candidates without a valid cached Jev answer: ${missing} (~${(missing * TOKENS_PER_REQUEST_ESTIMATE).toLocaleString()} tokens to fill)`);
  const judge = live && missing ? new Judge({ model: spec.config.jev.model, onUsage: (u) => usage.push(u) }) : undefined;

  for (const w of work) {
    if (judge) {
      const todo = w.requests.filter((r) => !valid(w, r));
      const answers = await mapLimit(todo, spec.config.jev.concurrency, (r) => askTriage(judge, w.change, r.flow, r.focus));
      todo.forEach((r, i) => (w.cache.entries[r.nodeId] = { key: r.key, raw: answers[i]! }));
      mkdirSync(join(EVAL_DIR, ".cache", "jev"), { recursive: true });
      writeFileSync(w.cacheFile, JSON.stringify(w.cache, null, 2) + "\n");
    }

    const labelOf = new Map(w.labels.affected.map((a) => [a.flow, a.confidence]));
    const judged = new Map(w.requests.filter((r) => valid(w, r)).map((r) => [r.nodeId, w.cache.entries[r.nodeId]!.raw]));
    const candidates = new Set(w.requests.map((r) => r.nodeId));
    for (const n of w.map.nodes) {
      if (n.kind === "synthetic") continue;
      const raw = judged.get(n.id);
      const row: FlowRow = {
        commit: w.c.sha,
        split: w.c.split,
        flow: n.id,
        label: labelOf.get(n.id) ?? null,
        candidate: candidates.has(n.id),
        predicted: raw ? decideTriage(raw, policy).affected : undefined,
      };
      rows.push(row);
      if (raw) raws.push({ row, raw });
    }
    // a labelled flow the crawler never mapped is still a miss, not a row to drop
    const mapped = new Set(w.map.nodes.map((n) => n.id));
    for (const a of w.labels.affected) {
      if (mapped.has(a.flow)) continue;
      rows.push({ commit: w.c.sha, split: w.c.split, flow: a.flow, label: a.confidence, candidate: false });
      notes.push(`${w.c.sha}: labelled flow ${a.flow} is not in the mind-map (crawler gap), counted as missed`);
    }
  }

  // ---- report ---------------------------------------------------------------
  const pluginTokens = [
    ...new Set(loadBindings(spec.appRoot, spec.config.crawler.expansions).flatMap((b) => Object.values(b.values).map((v) => v.replace(/^\//, "")))),
  ];
  const unjudged = rows.filter((r) => r.candidate && r.predicted === undefined).length;

  console.log("");
  console.log(allReviewed ? "LABELS: reviewed" : "LABELS: UNREVIEWED (drafted by the assistant, not yet checked by a human)");
  console.log(`questions=${QUESTIONS_HASH}  policy=${policyPath ?? "default"}  unjudged candidates=${unjudged}`);
  console.log("");
  console.log(pad("commit", 10) + pad("split", 8) + pad("labels", 8) + pad("cands", 7) + pad("det R", 7) + pad("det P", 7) + pad("sys R", 7) + pad("sys P", 7) + "  (sure labels; unsure excluded)");
  for (const w of work) {
    const r = rows.filter((x) => x.commit === w.c.sha);
    const d = score(r, "sure", "detector");
    const s = score(r, "sure", "system");
    const pos = r.filter((x) => x.label === "sure").length;
    console.log(pad(w.c.sha, 10) + pad(w.c.split, 8) + pad(String(pos), 8) + pad(String(w.requests.length), 7) + fmt(d.recall) + fmt(d.precision) + fmt(s.recall) + fmt(s.precision));
  }
  console.log("");
  for (const split of ["heldout", "dev", "train"] as const) {
    const subset = rows.filter((r) => r.split === split);
    if (!subset.length) continue;
    for (const [variant, data] of [
      ["pooled", subset],
      ["dedup", dedupeByTemplate(subset, pluginTokens)],
    ] as const) {
      for (const mode of ["sure", "all"] as const) {
        const d = score(data, mode, "detector");
        const s = score(data, mode, "system");
        console.log(`${pad(`${split.toUpperCase()} ${variant}`, 16)}${pad(mode === "sure" ? "sure" : "+unsure", 9)} detector ${line(d)}   system ${line(s)}`);
      }
    }
  }

  for (const split of ["heldout", "dev", "train"] as const) {
    const sel = raws.filter((x) => x.row.split === split && x.row.label !== "unsure");
    if (!sel.length) continue;
    console.log(`\nJev answers on detector candidates, ${split}, sure labels:`);
    for (const key of ["pRuns", "pAlters", "pPreserving", "impact", "criticality"] as const) {
      const pos = sel.filter((x) => x.row.label === "sure").map((x) => x.raw[key]);
      const neg = sel.filter((x) => x.row.label === null).map((x) => x.raw[key]);
      console.log(`  ${pad(key, 12)} affected: ${pad(summarize(pos), 38)} not affected: ${summarize(neg)}`);
    }
  }

  if (notes.length && args.includes("--notes")) console.log("\nnotes:\n  " + notes.join("\n  "));
  else if (notes.length) console.log(`\n${notes.length} notes (unmapped hunks, dropped hits); --notes to show`);
  if (usage.length) {
    const tok = usage.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0);
    console.log(`\nJev: ${usage.length} requests, ${tok.toLocaleString()} tokens, model=${usage[0]!.model}`);
  }

  mkdirSync(join(EVAL_DIR, "results"), { recursive: true });
  writeFileSync(join(EVAL_DIR, "results", "latest.json"), JSON.stringify({ questions: QUESTIONS_HASH, policy, reviewed: allReviewed, rows }, null, 2) + "\n");
}

const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w - 1) + " " : s + " ".repeat(w - s.length));
const fmt = (v: number | null) => pad(v === null ? "-" : v.toFixed(2), 7);
const line = (m: Metrics) => `R=${m.recall === null ? "-" : m.recall.toFixed(2)} P=${m.precision === null ? "-" : m.precision.toFixed(2)} (tp${m.tp} fp${m.fp} fn${m.fn})`;

main().catch((err) => {
  console.error("[eval] failed:", err);
  process.exit(1);
});
