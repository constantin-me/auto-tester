import { z } from "zod";

/**
 * The mind-map is the system's center of gravity (see plan Q5/Q7).
 * It is BOTH the map used to detect affected flows AND the baseline that live
 * behavior is diffed against. Its correctness = the system's correctness.
 *
 * Shape: a flow graph.
 *   - nodes  = UI states (a reachable screen/route)
 *   - edges  = user actions that move between states
 *   - assertions = leaf expectations attached to a node or edge
 *
 * Two guardrails against "grading its own homework" (plan Q10):
 *   - every mind-map write lands as a reviewable diff (committed-file store)
 *   - assertions marked `pinned: true` are authored by humans and are
 *     IMMUTABLE to agents (see mindmap/guard.ts)
 */

export const Provenance = z.object({
  /** repo-relative source files this element was derived from */
  sourceFiles: z.array(z.string()).default([]),
  /** how this element entered the map */
  origin: z.enum(["static-crawl", "llm-author", "qa-observed", "human"]),
  /** 0..1 — how much we trust this element. Human/pinned == 1. */
  confidence: z.number().min(0).max(1).default(0.5),
});
export type Provenance = z.infer<typeof Provenance>;

export const Assertion = z.object({
  id: z.string(),
  /** natural-language, LLM-interpretable statement of expected behavior */
  expectation: z.string(),
  /** optional machine-checkable hint (selector present, text visible, status code…) */
  check: z
    .object({
      kind: z.enum(["selector-visible", "text-present", "url-matches", "status-ok", "custom"]),
      value: z.string(),
    })
    .optional(),
  severityIfBroken: z.number().int().min(0).max(5).default(3),
  /** human-pinned assertions are immutable to agents */
  pinned: z.boolean().default(false),
  provenance: Provenance,
});
export type Assertion = z.infer<typeof Assertion>;

export const FlowNode = z.object({
  id: z.string(),
  /** human label, e.g. "Login page", "Collection dashboard" */
  label: z.string(),
  /** route/URL pattern that renders this state, when known */
  route: z.string().optional(),
  /** view/template that renders it, when known */
  view: z.string().optional(),
  /**
   * every view the handler can render, `view` first. A handler that early-returns a
   * fallback page (e.g. `no-collection`) renders its real page second.
   */
  views: z.array(z.string()).default([]),
  /**
   * page      = renders a view (a real UI state)
   * endpoint  = GET that redirects / downloads / returns data, no view
   * synthetic = derived grouping, e.g. global navigation from a shared partial
   */
  kind: z.enum(["page", "endpoint", "synthetic"]).default("page"),
  /** does reaching this state require auth? */
  requiresAuth: z.boolean().default(false),
  /** middleware guarding the route, e.g. ["requireAuth", "requireCollectionRole:editor"] */
  guards: z.array(z.string()).default([]),
  assertions: z.array(Assertion).default([]),
  provenance: Provenance,
  /** last live observation by the QA driver (origin qa-observed) */
  observed: z
    .object({
      at: z.string(),
      status: z.enum(["reachable", "unreachable-here", "untestable-no-data", "skipped"]),
      httpStatus: z.number().optional(),
      /** concrete path actually visited (params resolved) */
      path: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
});
export type FlowNode = z.infer<typeof FlowNode>;

export const FlowEdge = z.object({
  id: z.string(),
  from: z.string(), // FlowNode.id
  to: z.string(), // FlowNode.id
  /** the user action taking `from` -> `to`, e.g. "submit login form" */
  action: z.string(),
  /**
   * navigate = link (href) from a view
   * submit   = form post from a view, `to` = where the handler redirects
   * api      = fetch() from a view's script, stays on the page
   * unlinked = mutating route no view was found calling
   */
  kind: z.enum(["navigate", "submit", "api", "unlinked"]).default("unlinked"),
  /** HTTP method + path backing the action, when known */
  backing: z.object({ method: z.string(), path: z.string() }).optional(),
  assertions: z.array(Assertion).default([]),
  provenance: Provenance,
});
export type FlowEdge = z.infer<typeof FlowEdge>;

export const MindMap = z.object({
  schemaVersion: z.literal(1),
  /** repo identity this map describes */
  repo: z.string(),
  /** commit the map was last reconciled against */
  commit: z.string().optional(),
  generatedAt: z.string(), // ISO
  nodes: z.array(FlowNode).default([]),
  edges: z.array(FlowEdge).default([]),
});
export type MindMap = z.infer<typeof MindMap>;

export function emptyMindMap(repo: string): MindMap {
  return {
    schemaVersion: 1,
    repo,
    generatedAt: new Date().toISOString(),
    nodes: [],
    edges: [],
  };
}
