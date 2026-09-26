/**
 * Pure scoring for the detection + triage evaluation. No I/O.
 *
 * Two stages are scored separately because triage can only drop candidates:
 * detector recall is the ceiling of the whole system.
 */

export type LabelConfidence = "sure" | "unsure";

export interface FlowRow {
  commit: string;
  split: "train" | "dev" | "heldout" | "heldout2" | "heldout3";
  flow: string;
  /** null = labelled not affected */
  label: LabelConfidence | null;
  candidate: boolean;
  /** undefined = candidate not judged (no cached Jev answer) or not a candidate */
  predicted?: boolean;
  /** candidate reached only through app-level middleware (PER-62), reported separately */
  middlewareOnly?: boolean;
  /** Jev triage alone (before the execution check) */
  triageOnly?: boolean;
  /** how the change reached this candidate: direct, or the indirect mechanism */
  mechanism?: "direct" | "middleware" | "action" | "helper";
}

/** How `unsure` labels count: excluded from scoring, or counted as affected. */
export type Mode = "sure" | "all";

export interface Counts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface Metrics extends Counts {
  recall: number | null;
  precision: number | null;
}

function positive(row: FlowRow, mode: Mode): boolean | undefined {
  if (row.label === null) return false;
  if (row.label === "unsure" && mode === "sure") return undefined; // excluded
  return true;
}

function finish(c: Counts): Metrics {
  return {
    ...c,
    recall: c.tp + c.fn ? c.tp / (c.tp + c.fn) : null,
    precision: c.tp + c.fp ? c.tp / (c.tp + c.fp) : null,
  };
}

export function score(rows: FlowRow[], mode: Mode, stage: "detector" | "triage" | "system"): Metrics {
  const c: Counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const r of rows) {
    const pos = positive(r, mode);
    if (pos === undefined) continue;
    const pred = stage === "detector" ? r.candidate : stage === "triage" ? r.candidate && r.triageOnly === true : r.candidate && r.predicted === true;
    if (pred && pos) c.tp++;
    else if (pred && !pos) c.fp++;
    else if (!pred && pos) c.fn++;
    else c.tn++;
  }
  return finish(c);
}

/**
 * Collapse plugin siblings (`/book/:id`, `/dvd/:id`, …) into one route template per
 * commit: five near-copies are not five independent data points.
 */
export function dedupeByTemplate(rows: FlowRow[], pluginTokens: string[]): FlowRow[] {
  const re = pluginTokens.length ? new RegExp(`(?<=[:-])(${pluginTokens.map(escape).join("|")})(?=-|$)`, "g") : null;
  const groups = new Map<string, FlowRow>();
  for (const r of rows) {
    const key = `${r.commit}|${re ? r.flow.replace(re, "X") : r.flow}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { ...r, flow: key.split("|")[1]! });
      continue;
    }
    g.label = strongest(g.label, r.label);
    g.candidate ||= r.candidate;
    g.predicted = g.predicted === true || r.predicted === true ? true : g.predicted ?? r.predicted;
  }
  return [...groups.values()];
}

function strongest(a: LabelConfidence | null, b: LabelConfidence | null): LabelConfidence | null {
  if (a === "sure" || b === "sure") return "sure";
  if (a === "unsure" || b === "unsure") return "unsure";
  return null;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function summarize(values: number[]): string {
  if (!values.length) return "-";
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
  return `n=${s.length} min=${s[0]!.toFixed(2)} med=${q(0.5).toFixed(2)} max=${s[s.length - 1]!.toFixed(2)}`;
}
