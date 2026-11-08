import type { Assertion, MindMap } from "./schema.js";

/**
 * Pinning workflow: a human decides ground truth by pinning assertions.
 * Pinned assertions are immutable to agents (see guard.ts) and the comparator treats them as ground truth.
 * Pure functions over an in-memory map; the CLI (src/cli/pin.ts) does the loading and saving.
 */

export type AssertionFilter = {
  /** node ids: exact, or glob with `*` (e.g. `node:add-*`). For edge assertions this matches the edge id. */
  nodes?: string[];
  origin?: Assertion["provenance"]["origin"];
  pinned?: boolean;
  minSeverity?: number;
  /** case-insensitive substring of the expectation */
  grep?: string;
};

export type AssertionRow = {
  ownerKind: "node" | "edge";
  ownerId: string;
  assertion: Assertion;
};

/**
 * true when the filter narrows the set (used to refuse "pin everything"). `pinned` alone does
 * not count: `pin --unpinned` would still mean every unpinned assertion in the map.
 */
export function hasCriteria(f: AssertionFilter): boolean {
  return !!(f.nodes?.length || f.origin || f.minSeverity !== undefined || f.grep);
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

function matches(row: AssertionRow, f: AssertionFilter, owners: RegExp[] | undefined): boolean {
  const a = row.assertion;
  if (owners && !owners.some((r) => r.test(row.ownerId))) return false;
  if (f.origin && a.provenance.origin !== f.origin) return false;
  if (f.pinned !== undefined && a.pinned !== f.pinned) return false;
  if (f.minSeverity !== undefined && a.severityIfBroken < f.minSeverity) return false;
  if (f.grep && !a.expectation.toLowerCase().includes(f.grep.toLowerCase())) return false;
  return true;
}

function allRows(map: MindMap): AssertionRow[] {
  return [
    ...map.nodes.flatMap((n) => n.assertions.map((assertion) => ({ ownerKind: "node" as const, ownerId: n.id, assertion }))),
    ...map.edges.flatMap((e) => e.assertions.map((assertion) => ({ ownerKind: "edge" as const, ownerId: e.id, assertion }))),
  ];
}

export function listAssertions(map: MindMap, filter: AssertionFilter = {}): AssertionRow[] {
  const owners = filter.nodes?.length ? filter.nodes.map(globToRegExp) : undefined;
  return allRows(map).filter((r) => matches(r, filter, owners));
}

export type PinReport = { changed: string[]; alreadyInState: string[]; notFound: string[] };

const RESTORED_LLM_CONFIDENCE = 0.9;

function applyPin(a: Assertion, pinned: boolean): Assertion {
  if (pinned) return { ...a, pinned: true, provenance: { ...a.provenance, confidence: 1 } };
  const confidence = a.provenance.origin === "llm-author" ? RESTORED_LLM_CONFIDENCE : a.provenance.confidence;
  return { ...a, pinned: false, provenance: { ...a.provenance, confidence } };
}

/**
 * Pin or unpin assertions by exact id, on nodes and edges. Never touches anything else.
 * Pinning keeps `origin`, so an LLM-authored pinned assertion stays distinguishable from a human-written one.
 * An id that appears on several owners is applied to every occurrence.
 */
export function setPinned(map: MindMap, ids: string[], pinned: boolean): { map: MindMap; report: PinReport } {
  const wanted = new Set(ids);
  const seen = new Set<string>();
  const changed = new Set<string>();
  const already = new Set<string>();
  const apply = (list: Assertion[]) =>
    list.map((a) => {
      if (!wanted.has(a.id)) return a;
      seen.add(a.id);
      if (a.pinned === pinned) {
        already.add(a.id);
        return a;
      }
      changed.add(a.id);
      return applyPin(a, pinned);
    });
  const next: MindMap = {
    ...map,
    nodes: map.nodes.map((n) => (n.assertions.some((a) => wanted.has(a.id)) ? { ...n, assertions: apply(n.assertions) } : n)),
    edges: map.edges.map((e) => (e.assertions.some((a) => wanted.has(a.id)) ? { ...e, assertions: apply(e.assertions) } : e)),
  };
  return {
    map: next,
    report: {
      changed: [...changed],
      // an id with a partial change is reported as changed only
      alreadyInState: [...already].filter((id) => !changed.has(id)),
      notFound: [...wanted].filter((id) => !seen.has(id)),
    },
  };
}

/** Bulk: pin or unpin everything matching a filter. Throws on an empty filter (no "pin everything"). */
export function setPinnedByFilter(map: MindMap, filter: AssertionFilter, pinned: boolean): { map: MindMap; report: PinReport } {
  if (!hasCriteria(filter)) throw new Error("refusing to bulk-change every assertion: give at least one filter");
  const ids = [...new Set(listAssertions(map, filter).map((r) => r.assertion.id))];
  return setPinned(map, ids, pinned);
}
