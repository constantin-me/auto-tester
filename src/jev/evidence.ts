import type { JsonValue } from "@typesafe-ai/sdk";
import type { FlowNode } from "../mindmap/schema.js";
import type { ViewIndex } from "../bootstrap/ejs.js";
import { readText } from "../bootstrap/source.js";
import type { Candidate, Link } from "../detect/impact.js";

/**
 * Evidence for the execution check (PER-69), built entirely in code so Jev only judges
 * what it is shown:
 *   - what requests this flow actually sends (page load; for action links, the page's
 *     own form / fetch excerpt and the field names it posts)
 *   - the changed hunks that linked it
 *   - for render data: whether the flow's templates read the keys the change touches
 * Every excerpt is capped, and the state says when something was cut.
 */

const MAX_EXCERPT = 2500;
const MAX_HUNKS_CHARS = 6000;
const MAX_KEYS = 10;
const MAX_USES_PER_KEY = 4;

export interface EvidenceContext {
  appRoot: string;
  views: ViewIndex;
}

const cap = (s: string, n: number) => (s.length > n ? { text: s.slice(0, n), truncated: true } : { text: s, truncated: false });

/** Route params described, not sampled: a fixed sample id could itself trigger or dodge the change. */
function describeParams(route: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of route.matchAll(/:([A-Za-z_]\w*)/g)) {
    const name = m[1]!;
    out[name] = /id$/i.test(name)
      ? "a 24-character hexadecimal MongoDB ObjectId (any value, random per item)"
      : "any value the application generates for this segment";
  }
  return out;
}

/** Lines of the flow's templates where the page calls `path` (form action or fetch), with the fields it sends. */
function callSiteExcerpt(templates: string[], ctx: EvidenceContext, action: { method: string; path: string }): { [key: string]: JsonValue } {
  // the static head of the first segment, e.g. "/save-" for /save-books, "/api/" for /api/book/:id
  const head = "/" + (action.path.split("/").filter(Boolean)[0] ?? "").replace(/[:-].*$/, "");
  for (const rel of templates) {
    const text = readText(`${ctx.appRoot}/${rel}`);
    if (!text) continue;
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.includes(head) && /(action=|fetch\(|href=|url\s*=)/.test(l));
    if (at < 0) continue;
    // widen to the enclosing <form>…</form> when there is one, else a window around the call
    let start = Math.max(0, at - 12);
    let end = Math.min(lines.length, at + 20);
    const formStart = lines.slice(0, at + 1).map((l, i) => (/<form\b/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
    if (formStart !== undefined && at - formStart < 60) {
      const close = lines.findIndex((l, i) => i > at && /<\/form>/.test(l));
      if (close > 0 && close - formStart < 120) [start, end] = [formStart, close + 1];
    }
    const excerpt = lines.slice(start, end).join("\n");
    const fields = [...new Set([...excerpt.matchAll(/\bname=["']([^"']+)["']/g)].map((m) => m[1]!))];
    const { text: shown, truncated } = cap(excerpt, MAX_EXCERPT);
    return { template: rel, lines: `${start + 1}-${end}`, fields_sent: fields, excerpt: shown, excerpt_truncated: truncated };
  }
  return { template: null, note: "no call site found in this flow's templates" };
}

/** Object keys on changed lines (e.g. `hasActiveFilters: …`): candidate render data. */
function changedKeys(hunks: string[]): string[] {
  const keys = new Set<string>();
  for (const h of hunks) {
    for (const line of h.split("\n")) {
      if (!/^[+-][^+-]/.test(line)) continue;
      for (const m of line.matchAll(/\b([A-Za-z_]\w{3,})\s*:/g)) keys.add(m[1]!);
    }
  }
  return [...keys].slice(0, MAX_KEYS);
}

function templateUses(keys: string[], templates: string[], ctx: EvidenceContext) {
  return keys.map((key) => {
    const found: { template: string; line: number; text: string }[] = [];
    const re = new RegExp(`\\b${key}\\b`);
    for (const rel of templates) {
      const lines = (readText(`${ctx.appRoot}/${rel}`) ?? "").split("\n");
      lines.forEach((l, i) => {
        if (found.length < MAX_USES_PER_KEY && re.test(l)) found.push({ template: rel, line: i + 1, text: l.trim().slice(0, 200) });
      });
    }
    return { key, used_in_flow_templates: found.length ? found : "none found" };
  });
}

export function executionState(node: FlowNode, candidate: Candidate, ctx: EvidenceContext): { [key: string]: JsonValue } {
  const templates = ctx.views.chainAll(node.views.length ? node.views : node.view ? [node.view] : []);
  const route = node.route ?? "";
  const actions = candidate.links.filter((l): l is Link & { action: { method: string; path: string } } => l.kind === "action" && !!l.action);

  const requests: JsonValue[] = [{ kind: "page load", method: "GET", path: route }];
  for (const a of actions) requests.push({ kind: "action on this page", method: a.action.method, path: a.action.path, call_site: callSiteExcerpt(templates, ctx, a.action) });

  let budget = MAX_HUNKS_CHARS;
  const hunks: string[] = [];
  let hunksTruncated = false;
  for (const h of candidate.hunks) {
    if (budget <= 0) {
      hunksTruncated = true;
      break;
    }
    const { text, truncated } = cap(h, budget);
    hunks.push(text);
    hunksTruncated ||= truncated;
    budget -= text.length;
  }

  return {
    flow: {
      route,
      params: describeParams(route),
      templates,
      requests,
    },
    change: {
      why_linked: candidate.reasons.slice(0, 8),
      hunks,
      hunks_truncated: hunksTruncated,
      render_data_keys: templateUses(changedKeys(candidate.hunks), templates, ctx),
    },
  };
}
