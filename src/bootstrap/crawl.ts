import { relative, basename } from "node:path";
import type { CrawlerConfig } from "../config/config.js";
import { MindMap, FlowNode, FlowEdge, emptyMindMap } from "../mindmap/schema.js";
import { readText } from "./source.js";
import { routeRegex, linkRegex, paramCount, PARAM } from "./paths.js";
import { extractRoutes, findEntry, type RouteDef, type Binding } from "./express.js";
import { ViewIndex, detectViewDirs, type ViewLink } from "./ejs.js";

/**
 * Deterministic static crawler (plan M1, Q6-static half). No LLM, no creds.
 *
 *   routes (express.ts)  -> nodes: GET + view = page, GET without view = endpoint
 *   views  (ejs.ts)      -> edges: href = navigate, form = submit, fetch = api
 *   submit edges land where the POST handler redirects, so a flow reads
 *   "login page --submit--> POST /login --redirect--> home".
 *
 * An LLM pass later enriches labels + expected-behavior assertions on top of
 * this skeleton; human review pins the load-bearing ones.
 */

export interface CrawlResult {
  map: MindMap;
  /** view links no route matched — surfaced for review, not stored in the map */
  unresolved: ViewLink[];
  stats: { routes: number; pages: number; endpoints: number; links: number; resolvedLinks: number };
}

const GLOBAL_NAV_ID = "node:global-nav";

/** Template index for an app: configured view dirs, else the ones app.set('views') names. */
export function viewIndexFor(appRoot: string, crawler: CrawlerConfig): ViewIndex {
  const entry = findEntry(appRoot, crawler.entry);
  return new ViewIndex(appRoot, crawler.viewDirs ?? detectViewDirs(entry ? readText(entry) : undefined));
}

export function staticCrawl(appRoot: string, repo: string, crawler: CrawlerConfig): CrawlResult {
  const entry = findEntry(appRoot, crawler.entry);
  const routes = extractRoutes(appRoot, entry, crawler.expansions);
  const views = viewIndexFor(appRoot, crawler);

  // ---- nodes -------------------------------------------------------------
  const nodes = new Map<string, FlowNode>();
  const bindingOf = new Map<string, Binding | undefined>();
  for (const r of routes) {
    if (r.method !== "get") continue;
    const id = nodeId(r.path);
    const existing = nodes.get(id);
    if (existing) {
      if (!existing.provenance.sourceFiles.includes(r.file)) existing.provenance.sourceFiles.push(r.file);
      for (const v of r.views) if (!existing.views.includes(v)) existing.views.push(v);
      if (existing.views.length) existing.kind = "page";
      continue;
    }
    nodes.set(id, {
      id,
      label: labelFor(r.path),
      route: r.path,
      view: r.view,
      views: [...r.views],
      kind: r.views.length ? "page" : "endpoint",
      requiresAuth: r.guards.some((g) => /auth|role/i.test(g)),
      guards: r.guards,
      assertions: [],
      // expanded template routes may be conditional at runtime (e.g. only for plugins with search)
      provenance: { sourceFiles: [r.file], origin: "static-crawl", confidence: r.binding ? 0.4 : 0.6 },
    });
    bindingOf.set(id, r.binding);
  }

  // ---- which templates each page pulls in ---------------------------------
  const pageFiles = new Map<string, string[]>(); // nodeId -> abs files of every view it renders
  for (const n of nodes.values()) {
    const files = n.views.map((v) => views.resolveView(v)).filter((p): p is string => !!p);
    if (files.length) pageFiles.set(n.id, files);
  }
  const closures = new Map<string, Set<string>>(); // abs view -> included partials
  for (const abs of new Set([...pageFiles.values()].flat())) closures.set(abs, views.closure(abs));

  const includeCount = new Map<string, number>();
  for (const inc of closures.values()) for (const p of inc) includeCount.set(p, (includeCount.get(p) ?? 0) + 1);
  const globalPartials = new Set(
    [...includeCount].filter(([, c]) => c >= crawler.globalPartialThreshold).map(([p]) => p),
  );

  // ---- links per source node ----------------------------------------------
  const sources: { from: string; links: ViewLink[] }[] = [];
  for (const [id, viewFiles] of pageFiles) {
    const files = [...new Set(viewFiles.flatMap((abs) => [abs, ...[...closures.get(abs)!].filter((p) => !globalPartials.has(p))]))];
    sources.push({ from: id, links: files.flatMap((f) => views.linksIn(f)) });
  }
  const globalLinks = [...globalPartials].flatMap((p) => views.linksIn(p));
  if (globalLinks.length) {
    nodes.set(GLOBAL_NAV_ID, {
      id: GLOBAL_NAV_ID,
      label: `Global navigation (${[...globalPartials].map((p) => basename(p, ".ejs")).join(", ")})`,
      kind: "synthetic",
      views: [],
      requiresAuth: false,
      guards: [],
      assertions: [],
      provenance: {
        sourceFiles: [...globalPartials].map((p) => relative(appRoot, p)),
        origin: "static-crawl",
        confidence: 0.6,
      },
    });
    sources.push({ from: GLOBAL_NAV_ID, links: globalLinks });
  }

  // ---- edges ----------------------------------------------------------------
  const edges = new Map<string, FlowEdge>();
  const referenced = new Set<string>(); // "post /login"
  const unresolved: ViewLink[] = [];
  let linkCount = 0;
  let resolvedCount = 0;

  const addEdge = (e: Omit<FlowEdge, "id" | "assertions" | "provenance">, file: string, confidence: number) => {
    const id = `${e.kind}:${e.from}->${e.to}|${e.backing?.method ?? ""} ${e.backing?.path ?? ""}`;
    const existing = edges.get(id);
    if (existing) {
      if (!existing.provenance.sourceFiles.includes(file)) existing.provenance.sourceFiles.push(file);
      return;
    }
    edges.set(id, { ...e, id, assertions: [], provenance: { sourceFiles: [file], origin: "static-crawl", confidence } });
  };

  for (const { from, links } of sources) {
    const binding = bindingOf.get(from);
    for (const link of links) {
      linkCount++;
      const targets = resolveLink(link, routes, binding);
      if (!targets.length) {
        unresolved.push(link);
        continue;
      }
      resolvedCount++;
      for (const r of targets) {
        const backing = { method: r.method.toUpperCase(), path: r.path };
        if (link.kind === "navigate") {
          const to = nodeId(r.path);
          if (to !== from && nodes.has(to)) addEdge({ from, to, kind: "navigate", action: `open ${r.path}`, backing }, link.file, 0.6);
        } else if (link.kind === "submit") {
          referenced.add(`${r.method} ${r.path}`);
          const dests = r.redirects
            .flatMap((p) => resolveLink({ kind: "navigate", method: "get", path: p, file: r.file }, routes, binding))
            .map((d) => nodeId(d.path))
            .filter((d) => nodes.has(d));
          for (const to of dests.length ? [...new Set(dests)] : [from]) {
            addEdge({ from, to, kind: "submit", action: `submit form -> ${backing.method} ${r.path}`, backing }, link.file, 0.5);
          }
        } else {
          referenced.add(`${r.method} ${r.path}`);
          addEdge({ from, to: from, kind: "api", action: `fetch ${backing.method} ${r.path}`, backing }, link.file, 0.5);
        }
      }
    }
  }

  // mutating routes no view calls: keep them visible, anchored to the nearest page
  for (const r of routes) {
    if (r.method === "get" || referenced.has(`${r.method} ${r.path}`)) continue;
    const anchor = bestAnchor(r.path, nodes);
    addEdge(
      {
        from: anchor,
        to: anchor,
        kind: "unlinked",
        action: `${r.method.toUpperCase()} ${r.path}`,
        backing: { method: r.method.toUpperCase(), path: r.path },
      },
      r.file,
      0.3,
    );
  }

  const map = emptyMindMap(repo);
  map.nodes = [...nodes.values()];
  map.edges = [...edges.values()];
  const pages = map.nodes.filter((n) => n.kind === "page").length;
  return {
    map,
    unresolved,
    stats: {
      routes: routes.length,
      pages,
      endpoints: map.nodes.filter((n) => n.kind === "endpoint").length,
      links: linkCount,
      resolvedLinks: resolvedCount,
    },
  };
}

/**
 * Routes a normalized link can reach, best match first-tier only.
 * Scores: exact path 0, route pattern matches link 1, link pattern matches route 2.
 * A source node bound to a template binding (e.g. plugin "books") only reaches
 * routes of the same binding or unbound routes.
 */
function resolveLink(link: ViewLink, routes: RouteDef[], binding?: Binding): RouteDef[] {
  // a link made only of dynamic pieces (`/:param`) would match everything
  if (link.path.split("/").every((s) => s === "" || s === PARAM)) return [];
  const methodOk = (r: RouteDef) => r.method === link.method;

  const scored: { r: RouteDef; score: number }[] = [];
  for (const r of routes) {
    if (!methodOk(r)) continue;
    if (binding && r.binding && (r.binding.var !== binding.var || r.binding.key !== binding.key)) continue;
    const score =
      r.path === link.path ? 0 : routeRegex(r.path).test(link.path) ? 1 : link.path.includes(PARAM) && linkRegex(link.path).test(r.path) ? 2 : -1;
    if (score >= 0) scored.push({ r, score });
  }
  if (!scored.length) return [];
  const best = Math.min(...scored.map((s) => s.score));
  const tier = scored.filter((s) => s.score === best);
  const fewest = Math.min(...tier.map((s) => paramCount(s.r.path)));
  const out = tier.filter((s) => paramCount(s.r.path) === fewest).map((s) => s.r);
  // dedupe same path (same route mounted/declared twice)
  return [...new Map(out.map((r) => [`${r.method} ${r.path}`, r])).values()];
}

/** nearest GET node for a mutating path: exact, then first path segment, then root. */
function bestAnchor(path: string, nodes: Map<string, FlowNode>): string {
  const exact = nodeId(path);
  if (nodes.has(exact)) return exact;
  const segs = path.split("/").filter(Boolean);
  for (let i = segs.length - 1; i > 0; i--) {
    const id = nodeId("/" + segs.slice(0, i).join("/"));
    if (nodes.has(id)) return id;
  }
  const first = nodeId("/" + (segs[0] ?? ""));
  if (nodes.has(first)) return first;
  return nodeId("/");
}

export function nodeId(path: string): string {
  return "node:" + (path === "/" ? "root" : path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, ""));
}

function labelFor(path: string): string {
  if (path === "/") return "Home";
  const segs = path.split("/").filter(Boolean);
  const words = segs
    .map((s) => (s.startsWith(":") ? "{" + s.slice(1) + "}" : s))
    .join(" ")
    .replace(/[-_]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
