import { createHash } from "node:crypto";
import type { Assertion, FlowNode } from "../mindmap/schema.js";
import { routeRegex } from "../bootstrap/paths.js";
import type { PageEvidence } from "./driver.js";
import type { UiText } from "../jev/judgments.js";

/**
 * What to visit and how to read the result (M4).
 *
 * Every flow ends with an explicit status; only `failed` is a finding:
 *   ok                 checks ran and passed
 *   failed             checks ran and something is wrong
 *   unreachable-here   404 on this instance (e.g. the plugin's module is disabled)
 *   untestable-no-data no live link resolves the route's :params (empty wishlist, …)
 *   session-lost       redirected to the login page
 *   skipped            endpoint, synthetic, or on the deny list
 */
export type FlowStatus = "ok" | "failed" | "unreachable-here" | "untestable-no-data" | "session-lost" | "skipped";

export interface QaSettings {
  denyPaths: string[];
  visitEndpoints: boolean;
}

export interface PlannedVisit {
  node: FlowNode;
  /** concrete path to open; absent when the flow is not visited */
  path?: string;
  status?: FlowStatus;
  reason?: string;
}

/** Concrete path for a route: itself when it has no params, else the first harvested link it matches. */
export function resolvePath(route: string, links: string[]): string | undefined {
  if (!route.includes(":")) return route;
  const re = routeRegex(route);
  return links.find((l) => re.test(l));
}

export function planVisits(nodes: FlowNode[], links: string[], qa: QaSettings): PlannedVisit[] {
  return nodes.map((node) => {
    if (node.kind === "synthetic" || !node.route) return { node, status: "skipped", reason: "not a routed flow" };
    if (node.kind === "endpoint" && !qa.visitEndpoints) return { node, status: "skipped", reason: "endpoint (redirect/download/JSON); qa.visitEndpoints is off" };
    const denied = qa.denyPaths.find((d) => node.route!.includes(d));
    if (denied) return { node, status: "skipped", reason: `on the deny list (${denied})` };
    const path = resolvePath(node.route, links);
    if (!path) return { node, status: "untestable-no-data", reason: "no live link matches the route's parameters" };
    return { node, path };
  });
}

/** Status of a visit on its own (baseline mode: no earlier expectation to compare with). */
export function classify(ev: PageEvidence, loginPath: string, visitedPath: string): { status: FlowStatus; reason: string } {
  if (ev.httpStatus === 404) return { status: "unreachable-here", reason: "404 on this instance" };
  if (ev.httpStatus !== undefined && ev.httpStatus >= 400) return { status: "failed", reason: `HTTP ${ev.httpStatus}` };
  // a page that sends a signed-in user to the login page does so by design (e.g. /setup on an
  // installed instance); a real session loss is detected once per run by re-checking "/"
  if (ev.finalPath === loginPath && visitedPath !== loginPath) return { status: "ok", reason: "redirects to the login page" };
  return { status: "ok", reason: ev.settled ? "loaded" : "loaded (did not fully settle within the cap)" };
}

// every candidate is judged (in chunks, see classifyUiTexts); this only bounds pathological pages
const MAX_TEXTS = 200;

/** Texts worth asking about: headings, controls, field labels; short enough to be labels. */
export function candidateTexts(ev: PageEvidence): UiText[] {
  const ok = (t: string) => t.length >= 2 && t.length <= 80;
  return [
    ...ev.structure.headings.filter(ok).map((text) => ({ kind: "heading" as const, text })),
    ...ev.structure.buttons.filter(ok).map((text) => ({ kind: "control" as const, text })),
    ...ev.structure.labels.filter(ok).map((text) => ({ kind: "field" as const, text })),
  ].slice(0, MAX_TEXTS);
}

/** Texts that appear on most visited pages: the shared chrome, asserted once on the navigation node. */
export function globalTexts(pages: UiText[][], share = 0.6): Set<string> {
  const count = new Map<string, number>();
  for (const texts of pages) for (const t of new Set(texts.map((x) => x.text))) count.set(t, (count.get(t) ?? 0) + 1);
  const min = Math.max(3, Math.ceil(pages.length * share));
  return new Set([...count].filter(([, c]) => c >= min).map(([t]) => t));
}

const idFor = (nodeId: string, kind: string, value: string) =>
  `qa:${nodeId}:${kind}:${createHash("sha1").update(value).digest("hex").slice(0, 8)}`;

const PHRASE = {
  heading: (t: string) => `The page shows the heading "${t}".`,
  control: (t: string) => `The page offers a control labelled "${t}".`,
  field: (t: string) => `The page has a field labelled "${t}".`,
};
const SEVERITY = { heading: 2, control: 3, field: 3 };

/**
 * Baseline assertions for one page, composed by code from what the browser saw.
 * `texts` must already be filtered to fixed interface text (Jev) and exclude global chrome.
 */
export function observedAssertions(node: FlowNode, ev: PageEvidence, visitedPath: string, texts: UiText[]): Assertion[] {
  const provenance = { sourceFiles: node.provenance.sourceFiles, origin: "qa-observed" as const, confidence: 0.7 };
  if (ev.finalPath !== visitedPath) {
    return [
      {
        id: idFor(node.id, "redirect", ev.finalPath),
        expectation: `Opening ${node.route} redirects to ${ev.finalPath}.`,
        check: { kind: "url-matches", value: ev.finalPath },
        severityIfBroken: 3,
        pinned: false,
        provenance,
      },
    ];
  }
  return [
    {
      id: idFor(node.id, "status", "ok"),
      expectation: `The page ${node.route} loads without an HTTP error and stays on the page.`,
      check: { kind: "status-ok", value: "<400" },
      severityIfBroken: 4,
      pinned: false,
      provenance,
    },
    ...texts.map((t) => ({
      id: idFor(node.id, t.kind, t.text),
      expectation: PHRASE[t.kind](t.text),
      check: { kind: "text-present" as const, value: t.text },
      severityIfBroken: SEVERITY[t.kind],
      pinned: false,
      provenance,
    })),
  ];
}

/** Assertions for the shared chrome, recorded once on the navigation node. */
export function chromeAssertions(nodeId: string, sourceFiles: string[], texts: UiText[]): Assertion[] {
  const provenance = { sourceFiles, origin: "qa-observed" as const, confidence: 0.7 };
  return texts.map((t) => ({
    id: idFor(nodeId, t.kind, t.text),
    expectation: `Every signed-in page shows ${t.kind === "heading" ? "the heading" : t.kind === "control" ? "a control labelled" : "a field labelled"} "${t.text}".`,
    check: { kind: "text-present" as const, value: t.text },
    severityIfBroken: 3,
    pinned: false,
    provenance,
  }));
}

/** Replace a node's qa-observed assertions; human-pinned and other origins are kept as they are. */
export function withObserved(node: FlowNode, fresh: Assertion[]): FlowNode {
  const kept = node.assertions.filter((a) => a.pinned || a.provenance.origin !== "qa-observed");
  return { ...node, assertions: [...kept, ...fresh] };
}
