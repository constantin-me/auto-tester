import { dirname, relative } from "node:path";
import { literalsOf, resolveModule, stripComments } from "../bootstrap/source.js";
import { lineAt } from "../bootstrap/express.js";

/**
 * App-level mounts in the entry file, in registration order (PER-62).
 *
 * Express runs `app.use(...)` handlers in the order they were registered, for every
 * request under their prefix. So a changed middleware affects exactly the routes
 * mounted AFTER it under that prefix, and nothing mounted before it (static files,
 * early routers).
 */

export interface Mount {
  /** registration order in the entry file */
  order: number;
  /** 1-based lines of the whole `app.use(...)` call */
  span: { start: number; end: number };
  prefix: string;
  kind: "router" | "middleware" | "inline";
  /** identifier passed to app.use, for router/middleware */
  name?: string;
  /** module the identifier is imported from (abs), when relative */
  file?: string;
}

const APP_USE = /\b(\w+)\.use\s*\(/g;

/** Split call arguments on top-level commas. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      cur += c;
      if (c === "\\") cur += s[++i] ?? "";
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function closeParen(s: string): number {
  let depth = 1;
  let quote: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return s.length;
}

const isFunctionLiteral = (a: string) => /^(async\s+)?(function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(a);

/**
 * Parse the entry's `app.use` calls. `routeFiles` says which imported modules declare
 * routes (they are routers); any other imported identifier is middleware.
 */
export function appMounts(entryAbs: string, source: string, routeFiles: Set<string>): Mount[] {
  const text = stripComments(source);
  const appVar = text.match(/\b(?:const|let|var)\s+(\w+)\s*=\s*express\(\)/)?.[1] ?? "app";
  const imports = new Map<string, string>();
  for (const m of text.matchAll(/import\s+(\w+)\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const f = resolveModule(dirname(entryAbs), m[2]!);
    if (f) imports.set(m[1]!, f);
  }
  for (const m of text.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const f = resolveModule(dirname(entryAbs), m[2]!);
    if (!f) continue;
    for (const part of m[1]!.split(",")) {
      const local = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (local) imports.set(local, f);
    }
  }

  const mounts: Mount[] = [];
  for (const m of text.matchAll(APP_USE)) {
    if (m[1] !== appVar) continue;
    const argsAt = m.index! + m[0].length;
    const end = argsAt + closeParen(text.slice(argsAt));
    const args = splitArgs(text.slice(argsAt, end));
    const span = { start: lineAt(text, m.index!), end: lineAt(text, end) };
    // a first argument that is not itself a handler is the mount prefix
    const first = args[0] ?? "";
    const firstIsHandler = isFunctionLiteral(first) || imports.has(first.match(/^[A-Za-z_$][\w$]*/)?.[0] ?? "") || /\(/.test(first);
    const prefix = args.length > 1 && !firstIsHandler ? literalsOf(first).replace(/\/$/, "") : "";
    const handlers = args.length > 1 && !firstIsHandler ? args.slice(1) : args;
    for (const a of handlers) {
      const order = mounts.length;
      if (isFunctionLiteral(a)) {
        mounts.push({ order, span, prefix, kind: "inline" });
        continue;
      }
      const name = a.match(/^[A-Za-z_$][\w$]*/)?.[0];
      if (!name) continue;
      const file = imports.get(name);
      mounts.push({ order, span, prefix, kind: file && routeFiles.has(file) ? "router" : "middleware", name, file });
    }
  }
  return mounts;
}

/**
 * Position of a route file in the mount order: its own router mount, else the mount of
 * an entry-mounted module that (transitively) imports it, else Infinity ("mounted last",
 * e.g. plugin routers registered at runtime).
 */
export function mountOrderOf(
  file: string,
  mounts: Mount[],
  importers: Map<string, Set<string>>,
): { order: number; prefix: string; assumed: boolean } {
  const direct = mounts.filter((m) => m.file === file);
  if (direct.length) return { order: Math.min(...direct.map((m) => m.order)), prefix: direct[0]!.prefix, assumed: false };
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length) {
    const f = queue.shift()!;
    for (const imp of importers.get(f) ?? []) {
      if (seen.has(imp)) continue;
      seen.add(imp);
      const via = mounts.filter((m) => m.file === imp);
      if (via.length) return { order: Math.min(...via.map((m) => m.order)), prefix: via[0]!.prefix, assumed: false };
      queue.push(imp);
    }
  }
  return { order: Number.POSITIVE_INFINITY, prefix: "", assumed: true };
}

/** Human reason for a middleware-driven hit. */
export function middlewareReason(m: Mount, entryAbs: string, appRoot: string, assumed: boolean): string {
  const what = m.kind === "inline" ? "an inline app.use handler" : `app.use(${m.name})`;
  const where = `${relative(appRoot, entryAbs)}:${m.span.start}`;
  return `runs for every request after ${what} at ${where}${m.prefix ? ` under ${m.prefix}` : ""}` + (assumed ? " (route not mounted in the entry; assumed mounted last)" : "");
}
