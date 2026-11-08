import { join } from "node:path";
import type { FlowEdge, FlowNode } from "../mindmap/schema.js";
import type { RouteDef } from "../bootstrap/express.js";
import type { ViewIndex } from "../bootstrap/ejs.js";
import { readText } from "../bootstrap/source.js";
import { nodeId } from "../bootstrap/crawl.js";

/**
 * What the model is shown for one node: the handler source, every template the page
 * renders (view + partials), and the actions the static crawl already found. Nothing is
 * cut to fit: a node over the limit is skipped with a reason instead (a half-read
 * template would make the model invent the missing half).
 */

export interface EnrichContext {
  appRoot: string;
  routes: RouteDef[];
  views: ViewIndex;
  edges: FlowEdge[];
  maxEvidenceChars: number;
  /**
   * templates shared by most pages (header, nav): the crawler already models them as the
   * synthetic global-nav node, so they are named but not re-sent with every page
   */
  sharedFiles?: Set<string>;
}

export type Evidence =
  | { ok: true; text: string; sourceFiles: string[] }
  | { ok: false; reason: string };

export function gatherEvidence(node: FlowNode, ctx: EnrichContext): Evidence {
  if (node.kind !== "page") return { ok: false, reason: `skipped: ${node.kind} node has no view to read` };

  const blocks: string[] = [];
  const files: string[] = [];
  const add = (title: string, rel: string, body: string) => {
    blocks.push(`### ${title} — ${rel}\n\`\`\`\n${body}\n\`\`\``);
    if (!files.includes(rel)) files.push(rel);
  };

  const routes = ctx.routes.filter((r) => r.method === "get" && nodeId(r.path) === node.id);
  for (const r of routes) {
    const lines = (readText(join(ctx.appRoot, r.file)) ?? "").split("\n");
    add(`Route GET ${r.path}${r.guards.length ? ` (guards: ${r.guards.join(", ")})` : ""}`, `${r.file}:${r.span.start}-${r.span.end}`, lines.slice(r.span.start - 1, r.span.end).join("\n"));
    if (r.referenced) add("Handler it delegates to", r.referenced.file, r.referenced.body.trim());
  }
  if (!routes.length) return { ok: false, reason: "skipped: no GET route found for this node in the source" };

  const templates = ctx.views.chainAll(node.views.length ? node.views : node.view ? [node.view] : []);
  const shared = templates.filter((t) => ctx.sharedFiles?.has(t));
  for (const rel of templates.filter((t) => !ctx.sharedFiles?.has(t))) add("Template", rel, (readText(join(ctx.appRoot, rel)) ?? "").trimEnd());

  if (shared.length) blocks.push(`### Shared templates included but not shown (global navigation, described on its own node)\n${shared.map((t) => `- ${t}`).join("\n")}`);

  const actions = ctx.edges
    .filter((e) => e.from === node.id)
    .map((e) => `- ${e.kind}: ${e.action}${e.backing ? ` (${e.backing.method.toUpperCase()} ${e.backing.path})` : ""} -> ${e.to}`);
  if (actions.length) blocks.push(`### Actions the static crawl linked from this page\n${actions.join("\n")}`);

  const text = blocks.join("\n\n");
  if (text.length > ctx.maxEvidenceChars) {
    return { ok: false, reason: `skipped-too-large: evidence is ${text.length} chars, limit ${ctx.maxEvidenceChars} (raise enrich.maxEvidenceChars)` };
  }
  return { ok: true, text, sourceFiles: files.map((f) => f.replace(/:\d+-\d+$/, "")) };
}
