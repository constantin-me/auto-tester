import { MindMap, Assertion } from "./schema.js";

/**
 * The anti-"grade its own homework" guard (plan Q10).
 *
 * When a new map is (re)authored by the crawler or an LLM, human-pinned
 * assertions from the existing map must survive untouched. Agents may add,
 * update or drop their own assertions freely, but must never overwrite or
 * delete a `pinned: true` one.
 *
 * mergePreservingPins takes the freshly authored map and folds every pinned
 * assertion from the previous map back in, keyed by (nodeId/edgeId, assertion.id).
 */
export function mergePreservingPins(previous: MindMap, next: MindMap): MindMap {
  const pinnedByNode = new Map<string, Assertion[]>();
  const pinnedByEdge = new Map<string, Assertion[]>();

  for (const n of previous.nodes) {
    const pins = n.assertions.filter((a) => a.pinned);
    if (pins.length) pinnedByNode.set(n.id, pins);
  }
  for (const e of previous.edges) {
    const pins = e.assertions.filter((a) => a.pinned);
    if (pins.length) pinnedByEdge.set(e.id, pins);
  }

  const merged: MindMap = {
    ...next,
    nodes: next.nodes.map((n) => reattach(n, pinnedByNode.get(n.id) ?? [])),
    edges: next.edges.map((e) => reattach(e, pinnedByEdge.get(e.id) ?? [])),
  };
  return merged;
}

/**
 * Live observations survive a re-crawl: the static crawl rebuilds structure from code,
 * but what the browser saw (`observed`, `qa-observed` assertions) is only refreshed by
 * a new QA baseline. Carried over for every node that still exists.
 */
export function carryObservations(previous: MindMap, next: MindMap): MindMap {
  const prev = new Map(previous.nodes.map((n) => [n.id, n]));
  return {
    ...next,
    nodes: next.nodes.map((n) => {
      const p = prev.get(n.id);
      if (!p) return n;
      const observedAssertions = p.assertions.filter((a) => a.provenance.origin === "qa-observed" && !a.pinned);
      const ids = new Set(n.assertions.map((a) => a.id));
      return {
        ...n,
        ...(p.observed ? { observed: p.observed } : {}),
        assertions: [...n.assertions, ...observedAssertions.filter((a) => !ids.has(a.id))],
      };
    }),
  };
}

function reattach<T extends { assertions: Assertion[] }>(el: T, pins: Assertion[]): T {
  if (!pins.length) return el;
  // drop any agent assertion colliding with a pinned id, then add the pins back
  const pinnedIds = new Set(pins.map((p) => p.id));
  const kept = el.assertions.filter((a) => !pinnedIds.has(a.id));
  return { ...el, assertions: [...kept, ...pins] };
}
