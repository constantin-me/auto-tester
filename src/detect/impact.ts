import { dirname, extname, join, relative } from "node:path";
import type { CrawlerConfig } from "../config/config.js";
import type { MindMap } from "../mindmap/schema.js";
import type { ChangeContext } from "../jev/judgments.js";
import { fileAt, parseHunks, spanTouched, touchedBaseLines, type Hunk } from "../diff/git.js";
import { findEntry, loadBindings, mountPrefixes, routesInText, type Binding, type RouteDef } from "../bootstrap/express.js";
import { viewIndexFor } from "../bootstrap/crawl.js";
import { readText, resolveModule, walk } from "../bootstrap/source.js";
import { nodeId } from "../bootstrap/crawl.js";
import { declarations, stripComments, type Declaration } from "./declarations.js";
import { appMounts, middlewareReason, mountOrderOf, type Mount } from "./middleware.js";

/**
 * Diff -> candidate flows (plan Q6, static half; PER-46).
 *
 * For every hunk:
 *   - inside a route declaration/handler (parsed at the BASE revision, so line
 *     numbers match the diff)            -> that route's flow
 *   - inside another named function      -> follow the symbol to its users: same
 *     file first, then importers, a few hops (a changed helper reaches the
 *     routes that call it)
 *   - in a template                      -> every page whose view includes it
 * Mutating routes map to the pages whose actions call them.
 *
 * Output is a candidate list with reasons and the hunks that justify each one.
 * Jev triage then judges each candidate; this stage only has to not miss.
 */

/**
 * How a change reached a flow. `handler` and `template` are direct (the flow's own code
 * changed); the rest are indirect and may not matter for this flow's requests.
 */
export type LinkKind = "handler" | "template" | "action" | "helper" | "middleware";
export interface Link {
  kind: LinkKind;
  /** for `action`: the route the page calls */
  action?: { method: string; path: string };
}
export const isDirect = (l: Link) => l.kind === "handler" || l.kind === "template";

export interface Candidate {
  nodeId: string;
  reasons: string[];
  /** hunk texts relevant to this flow */
  hunks: string[];
  links: Link[];
}

export interface Detection {
  candidates: Candidate[];
  /** hunks that could not be tied to any flow (imports, top-level code, unsupported files) */
  unmapped: { file: string; header: string; why: string }[];
  /** flows the analysis reached that the mind-map does not contain: a map/code mismatch, should be empty */
  dropped: string[];
}

const MAX_HOPS = 3;

export function detectCandidates(
  appRoot: string,
  map: MindMap,
  change: ChangeContext,
  /** revision the diff is against; null when `appRoot` already holds the base tree */
  baseRev: string | null,
  crawler: CrawlerConfig,
): Detection {
  const entry = findEntry(appRoot, crawler.entry);
  const prefixes = entry ? mountPrefixes(entry) : new Map<string, string[]>();
  const bindings = loadBindings(appRoot, crawler.expansions);
  const views = viewIndexFor(appRoot, crawler);
  const nodeIds = new Set(map.nodes.map((n) => n.id));

  const hits = new Map<string, { reasons: Set<string>; hunks: Set<string>; links: Map<string, Link> }>();
  const unmapped: Detection["unmapped"] = [];
  const dropped = new Set<string>();
  const hit = (id: string, reason: string, hunk: string, link: Link) => {
    if (!nodeIds.has(id)) {
      dropped.add(id);
      return;
    }
    const h = hits.get(id) ?? { reasons: new Set(), hunks: new Set(), links: new Map() };
    h.reasons.add(reason);
    h.hunks.add(hunk);
    h.links.set(`${link.kind} ${link.action?.method ?? ""} ${link.action?.path ?? ""}`, link);
    hits.set(id, h);
  };
  // `direct`: the hunk is inside this route's own handler (vs reached through a helper chain)
  const hitRoute = (r: RouteDef, reason: string, hunk: string, direct: boolean) => {
    const label = `${r.method.toUpperCase()} ${r.path}`;
    if (r.method === "get") {
      hit(nodeId(r.path), reason.replace("{route}", label), hunk, { kind: direct ? "handler" : "helper" });
      return;
    }
    // a mutating route belongs to the flows whose pages trigger it
    for (const e of map.edges) {
      if (e.backing?.method === r.method.toUpperCase() && e.backing.path === r.path) {
        hit(e.from, reason.replace("{route}", label) + ` (action on this page)`, hunk, {
          kind: "action",
          action: { method: r.method.toUpperCase(), path: r.path },
        });
      }
    }
  };

  const routesCache = new Map<string, RouteDef[]>();
  const routesOf = (abs: string, rel: string, text: string, key: string) => {
    if (!routesCache.has(key)) routesCache.set(key, routesInText(text, abs, rel, prefixes.get(abs) ?? [""], bindings));
    return routesCache.get(key)!;
  };

  const importers = importerIndex(appRoot);
  const queue: { abs: string; rel: string; text: string; name: string; origin: string; hunk: string; hops: number }[] = [];

  // ---- app-level middleware (PER-62) -----------------------------------------
  // a changed middleware reaches every flow mounted after it under its prefix
  const routeFiles = new Set(map.nodes.flatMap((n) => n.provenance.sourceFiles.map((f) => join(appRoot, f))));
  const mountsFor = (text: string) => (entry ? appMounts(entry, text, routeFiles) : []);
  const mounts = mountsFor(entry ? readText(entry) ?? "" : "");
  const flowOrder = new Map(
    map.nodes.map((n) => {
      const orders = n.provenance.sourceFiles.map((f) => mountOrderOf(join(appRoot, f), mounts, importers));
      const best = orders.sort((a, b) => a.order - b.order)[0] ?? { order: Number.POSITIVE_INFINITY, assumed: true, prefix: "" };
      return [n.id, best] as const;
    }),
  );
  const hitMiddleware = (m: Mount, origin: string, hunk: string) => {
    for (const n of map.nodes) {
      if (n.kind === "synthetic") continue;
      const at = flowOrder.get(n.id)!;
      if (at.order <= m.order) continue; // mounted before the middleware: never runs through it
      if (m.prefix && !(n.route ?? "").startsWith(m.prefix)) continue;
      hit(n.id, `${origin}; ${middlewareReason(m, entry!, appRoot, at.assumed)}`, hunk, { kind: "middleware" });
    }
  };

  for (const file of change.files) {
    const abs = join(appRoot, file.path);
    const hunks = parseHunks(file.patch);
    const ext = extname(file.path);

    if (ext === ".ejs") {
      for (const n of map.nodes) {
        // every view the handler can render, not just the first (an early-return fallback
        // page would otherwise hide the real one)
        for (const view of n.views.length ? n.views : n.view ? [n.view] : []) {
          const viewAbs = views.resolveView(view);
          if (!viewAbs) continue;
          const reason =
            viewAbs === abs
              ? `renders ${file.path} (changed)`
              : views.closure(viewAbs).has(abs)
                ? `renders ${relative(appRoot, viewAbs)}, which includes ${file.path} (changed)`
                : undefined;
          if (reason) for (const h of hunks) hit(n.id, reason, h.text, { kind: "template" });
        }
      }
      continue;
    }
    if (ext !== ".ts" && ext !== ".js") {
      for (const h of hunks) unmapped.push({ file: file.path, header: header(h), why: `unsupported file type ${ext || "(none)"}` });
      continue;
    }

    // parse the file as it was BEFORE the change so hunk line numbers line up
    const baseText = (baseRev ? fileAt(appRoot, baseRev, file.path) : undefined) ?? readText(abs) ?? "";
    const routes = routesOf(abs, file.path, baseText, `${baseRev ?? "tree"}:${file.path}`);
    const decls = declarations(baseText);

    // hunks inside an inline `app.use((req, res, next) => …)` of the entry, as it was before
    const inlineMounts = abs === entry ? mountsFor(baseText).filter((m) => m.kind === "inline") : [];

    for (const h of hunks) {
      const touched = touchedBaseLines(h);
      const inInline = inlineMounts.filter((m) => spanTouched(m.span, touched));
      for (const m of inInline) hitMiddleware(m, `${file.path}: inline middleware changed`, h.text);
      const owning = routes.filter((r) => spanTouched(r.span, touched));
      if (owning.length) {
        for (const r of owning) hitRoute(r, `handler of {route} changed`, h.text, true);
        continue;
      }
      // innermost function around each touched line / insertion point
      const points = [...touched.removed, ...touched.insertedAfter.map((p) => p + 0.5)];
      const changedFns = new Set<Declaration>();
      for (const p of points) {
        const d = decls.filter((x) => x.start <= p && p <= x.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
        if (d) changedFns.add(d);
      }
      if (!changedFns.size) {
        if (!inInline.length) {
          unmapped.push({ file: file.path, header: header(h), why: "not inside a route or function (imports, new top-level declarations)" });
        }
        continue;
      }
      for (const d of changedFns) {
        queue.push({ abs, rel: file.path, text: baseText, name: d.name, origin: `${file.path}: ${d.name}() changed`, hunk: h.text, hops: 0 });
      }
    }
  }

  // follow changed symbols to the routes that use them
  const seen = new Set<string>();
  while (queue.length) {
    const item = queue.shift()!;
    const key = `${item.abs}#${item.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const uses = new RegExp(`\\b${item.name.replace(/\$/g, "\\$")}\\b`);
    // a mention in a comment is not a use
    const lines = stripComments(item.text).split("\n");
    const spanText = (s: { start: number; end: number }) => lines.slice(s.start - 1, s.end).join("\n");

    // same file: routes and other functions that reference the symbol
    const routes = routesOf(item.abs, item.rel, item.text, `${item.abs}@${item.text.length}`);
    const decls = declarations(item.text);
    const own = decls.find((d) => d.name === item.name);
    for (const r of routes) {
      // used in the handler, or applied as a guard (inline or via router.use)
      const guarded = r.guards.some((g) => g.replace(/^\.\.\./, "").split(":")[0] === item.name);
      if (guarded || uses.test(spanText(r.span))) hitRoute(r, `{route} uses ${item.origin}`, item.hunk, false);
    }
    // the entry registers it with app.use: every flow mounted after it runs through it
    if (item.abs === entry) {
      for (const m of mounts) if (m.kind === "middleware" && m.name === item.name) hitMiddleware(m, item.origin, item.hunk);
    }
    if (item.hops >= MAX_HOPS) continue;
    for (const d of decls) {
      if (d === own || d.name === item.name) continue;
      if (own && d.start <= own.start && d.end >= own.end) continue; // an enclosing factory is not a user
      if (uses.test(spanText(d))) queue.push({ ...item, name: d.name, origin: `${item.origin} via ${d.name}()`, hops: item.hops + 1 });
    }
    // other files importing this one
    for (const impAbs of importers.get(item.abs) ?? []) {
      const text = readText(impAbs);
      if (!text || !uses.test(stripComments(text))) continue;
      const rel = impAbs.slice(appRoot.length + 1);
      queue.push({ abs: impAbs, rel, text, name: item.name, origin: item.origin, hunk: item.hunk, hops: item.hops + 1 });
    }
  }

  const candidates = [...hits]
    .map(([id, h]) => ({ nodeId: id, reasons: [...h.reasons], hunks: [...h.hunks], links: [...h.links.values()] }))
    .sort((a, b) => b.reasons.length - a.reasons.length || a.nodeId.localeCompare(b.nodeId));
  return { candidates, unmapped, dropped: [...dropped] };
}

/** abs file -> files that import it (relative imports, re-exports, dynamic imports, require). */
function importerIndex(appRoot: string): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  for (const abs of walk(appRoot).filter((f) => [".ts", ".js"].includes(extname(f)))) {
    const text = readText(abs);
    if (!text) continue;
    const specs = [
      ...text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g),
      ...text.matchAll(/(?:import|require)\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]!);
    for (const spec of specs) {
      const target = resolveModule(dirname(abs), spec);
      if (!target) continue;
      const set = idx.get(target) ?? new Set<string>();
      set.add(abs);
      idx.set(target, set);
    }
  }
  return idx;
}

function header(h: Hunk): string {
  return h.text.split("\n")[0]!;
}

export type { Binding };
