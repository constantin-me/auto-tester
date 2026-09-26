import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, extname } from "node:path";
import type { Expansion } from "../config/config.js";
import { walk, readText, resolveModule, literalsOf, stripComments } from "./source.js";
import { normalizePath, isAssetPath, PARAM } from "./paths.js";

/**
 * Static extraction of Express routes.
 *
 * Handles what the M1 skeleton got wrong:
 *   - mount prefixes: app.use(BASE_URL + '/admin', adminRoutes) prefixes every
 *     route in adminRoutes' file with /admin
 *   - template routes: `/add-${plugin.id}` expanded once per binding from config
 *   - per-handler facts (view, guards, redirects) read from the handler's own
 *     span, not the first match anywhere in the file
 */

export interface Binding {
  var: string;
  /** the binding's source dir name, e.g. "books" for plugins/books/index.ts */
  key: string;
  values: Record<string, string>;
}

export interface RouteDef {
  method: string; // lowercase
  path: string; // full normalized path, mount prefix applied
  file: string; // repo-relative
  guards: string[];
  view?: string;
  /** every view the handler renders, `view` first */
  views: string[];
  redirects: string[];
  /** set when the path came from template expansion */
  binding?: Binding;
  /** 1-based inclusive lines of the route declaration + inline handler in `file` */
  span: { start: number; end: number };
}

const ROUTE_RE =
  /\b(app|router|\w*[Rr]outer)\.(get|post|put|delete|patch)\s*\(\s*(?:[A-Za-z_$][\w.$]*\s*\+\s*)?(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g;
const RENDER_RE = /\bres\.render\s*\(\s*['"`]([^'"`]+)['"`]/g;
const REDIRECT_RE = /\bres\.redirect\s*\(\s*(?:\d+\s*,\s*)?(?:[A-Za-z_$][\w.$]*\s*\+\s*)?(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g;
const HANDLER_START = /\basync\b|\(\s*_?req\b|\bfunction\b|\b_?req\s*=>/;
const GUARD_TOKEN = /(\.\.\.)?\b([A-Za-z_$][\w$.]*)(?:\(\s*['"]([^'"]*)['"]\s*\))?/g;
/**
 * Start of a declarative route-table entry: `{ method: 'get', path: '/api/x', …`. The rest
 * of the object (flags, and a handler given by reference, as an arrow/function value, or as
 * an `async handler() {}` method) is taken by brace matching, so a handler body with braces
 * in it no longer hides the route.
 */
const ROUTE_TABLE_START = /\{\s*method\s*:\s*['"](\w+)['"]\s*,\s*path\s*:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g;
const IGNORED_TOKENS = new Set(["req", "res", "next", "any", "async", "await"]);

export const ENTRY_CANDIDATES = ["app.ts", "app.js", "server.ts", "server.js", "index.ts", "index.js", "src/app.ts", "src/server.ts", "src/index.ts"];

export function findEntry(appRoot: string, configured?: string): string | undefined {
  if (configured) return existsSync(join(appRoot, configured)) ? join(appRoot, configured) : undefined;
  return ENTRY_CANDIDATES.map((c) => join(appRoot, c)).find((p) => existsSync(p));
}

/** router file (abs) -> mount prefixes, from `import X from './routes/x.js'` + `app.use(prefixExpr, X)` in the entry file. */
export function mountPrefixes(entryAbs: string): Map<string, string[]> {
  const text = readText(entryAbs) ?? "";
  const importByVar = new Map<string, string>();
  for (const m of text.matchAll(/import\s+(\w+)\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const resolved = resolveModule(dirname(entryAbs), m[2]!);
    if (resolved) importByVar.set(m[1]!, resolved);
  }
  const prefixes = new Map<string, string[]>();
  for (const m of text.matchAll(/\.use\(\s*([^;]*?)\s*,\s*(\w+)\s*\)\s*;/g)) {
    const file = importByVar.get(m[2]!);
    if (!file) continue;
    const prefix = literalsOf(m[1]!).replace(/\/$/, "");
    const list = prefixes.get(file) ?? [];
    if (!list.includes(prefix)) list.push(prefix);
    prefixes.set(file, list);
  }
  return prefixes;
}

/** Load bindings for each configured expansion, e.g. one per plugins/<dir>/index.ts. */
export function loadBindings(appRoot: string, expansions: Expansion[]): Binding[] {
  const out: Binding[] = [];
  for (const exp of expansions) {
    const [head, tail = ""] = exp.from.split("*");
    const dir = join(appRoot, head!);
    let dirs: string[] = [];
    try {
      dirs = readdirSync(dir);
    } catch {
      continue;
    }
    for (const key of dirs) {
      const text = readText(join(dir, key, tail.replace(/^\//, "")));
      if (!text) continue;
      const values: Record<string, string> = {};
      for (const field of exp.fields) {
        const m = text.match(new RegExp(`^\\s*${field}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`, "m"));
        if (m) values[field] = m[1]!;
      }
      if (Object.keys(values).length) out.push({ var: exp.var, key, values });
    }
  }
  return out;
}

/** Expand `${var.field}` against bindings; leftover `${…}` become :name params. */
function expand(templated: string, bindings: Binding[]): { path: string; binding?: Binding }[] {
  const rawPath = templated.replace(/^\$\{[^}]*base[^}]*\}/i, "");
  const vars = new Set([...rawPath.matchAll(/\$\{\s*(\w+)\.\w+\s*\}/g)].map((m) => m[1]!));
  const relevant = bindings.filter((b) => vars.has(b.var));
  const leftovers = (p: string) => p.replace(/\$\{\s*([\w.]+)\s*\}/g, (_, expr: string) => ":" + expr.replace(/\./g, "_"));
  if (!relevant.length) return [{ path: leftovers(rawPath) }];

  const out: { path: string; binding?: Binding }[] = [];
  for (const b of relevant) {
    let complete = true;
    const p = rawPath.replace(/\$\{\s*(\w+)\.(\w+)\s*\}/g, (whole, v: string, f: string) => {
      if (v !== b.var) return whole;
      const val = b.values[f];
      if (val === undefined) complete = false;
      return val ?? whole;
    });
    if (complete) out.push({ path: leftovers(p), binding: b });
  }
  return out;
}

/** Index of the `close` matching an `open` just before `s` (default: parens); s.length if unbalanced. */
function closingParen(s: string, open = "(", close = ")"): number {
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
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return s.length;
}

/** local name -> module file, from `import * as ns from` and `import { a, b as c } from`. */
function namedImports(fileAbs: string, text: string): Map<string, { file: string; name?: string }> {
  const out = new Map<string, { file: string; name?: string }>();
  for (const m of text.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const file = resolveModule(dirname(fileAbs), m[2]!);
    if (file) out.set(m[1]!, { file });
  }
  for (const m of text.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const file = resolveModule(dirname(fileAbs), m[2]!);
    if (!file) continue;
    for (const part of m[1]!.split(",")) {
      const [orig, local] = part.trim().split(/\s+as\s+/);
      if (orig) out.set((local ?? orig).trim(), { file, name: orig.trim() });
    }
  }
  return out;
}

/** Source of a named function/const in `text`, up to the next top-level declaration. */
function functionBody(text: string, name: string): string | undefined {
  const start = text.search(
    new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:(?:const|let|var)\\s+${name}\\s*=|(?:async\\s+)?function\\s+${name}\\s*\\()`),
  );
  if (start < 0) return undefined;
  const rest = text.slice(start + 1);
  const next = rest.search(/\n(?:export\s|const\s|let\s|function\s|async\s+function\s)/);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * Body of a handler passed by reference (`authController.login_get`, `login_get`),
 * resolved through the route file's imports or its own top-level functions.
 */
function referencedHandler(ref: string, fileAbs: string, text: string): { body: string; file: string } | undefined {
  const imports = namedImports(fileAbs, text);
  const [head, member] = ref.split(".");
  if (member) {
    const mod = imports.get(head!);
    const modText = mod && readText(mod.file);
    const body = modText && functionBody(modText, member);
    return body ? { body, file: mod!.file } : undefined;
  }
  const imp = imports.get(head!);
  if (imp) {
    const modText = readText(imp.file);
    const body = modText && functionBody(modText, imp.name ?? head!);
    return body ? { body, file: imp.file } : undefined;
  }
  const body = functionBody(text, head!);
  return body ? { body, file: fileAbs } : undefined;
}

/** What a handler renders and where it redirects. */
interface HandlerFacts {
  /** first rendered view */
  view?: string;
  /** every rendered view, in source order */
  views: string[];
  redirects: string[];
}
const NO_FACTS: HandlerFacts = { views: [], redirects: [] };

function viewAndRedirects(body: string): HandlerFacts {
  const views = [...new Set([...body.matchAll(RENDER_RE)].map((m) => m[1]!))];
  const redirects = [
    ...new Set(
      [...body.matchAll(REDIRECT_RE)]
        .map((r) => normalizePath(r[1] ?? r[2] ?? r[3] ?? ""))
        .filter((p): p is string => !!p && !p.includes(PARAM)),
    ),
  ];
  return { view: views[0], views, redirects };
}

function guardsOf(argSegment: string): string[] {
  const guards: string[] = [];
  for (const m of argSegment.matchAll(GUARD_TOKEN)) {
    const [, spread, name, arg] = m;
    if (!name || IGNORED_TOKENS.has(name)) continue;
    guards.push(spread ? `...${name}` : arg ? `${name}:${arg}` : name);
  }
  return guards;
}

export function extractRoutes(appRoot: string, entryAbs: string | undefined, expansions: Expansion[]): RouteDef[] {
  const prefixes = entryAbs ? mountPrefixes(entryAbs) : new Map<string, string[]>();
  const bindings = loadBindings(appRoot, expansions);
  const files = walk(appRoot).filter((f) => [".ts", ".js"].includes(extname(f)) && !f.includes(`${join(appRoot, "public")}`));
  const routes: RouteDef[] = [];
  for (const abs of files) {
    const text = readText(abs);
    if (text) routes.push(...routesInText(text, abs, relative(appRoot, abs), prefixes.get(abs) ?? [""], bindings));
  }
  return routes;
}

/** 1-based line of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Routes declared in one file's text. Works on any version of the file (e.g. the
 * base side of a diff), which is how diff hunks are mapped to their handlers.
 * `abs` is used to resolve referenced handlers through the file's imports.
 */
export function routesInText(source: string, abs: string, rel: string, filePrefixes: string[], bindings: Binding[]): RouteDef[] {
  // comments removed (lines kept): an apostrophe in a comment would otherwise open a
  // fake string in closingParen and cut the handler's span short
  const text = stripComments(source);
  const routes: RouteDef[] = [];
  const matches = [...text.matchAll(ROUTE_RE)];
  // `router.use(requireAuth, …)` guards every route the router declares after it
  const routerUses = [...text.matchAll(/\b(\w*[Rr]outer)\.use\s*\(/g)].map((u) => {
    const argsAt = u.index! + u[0].length;
    return { line: lineAt(text, u.index!), guards: guardsOf(text.slice(argsAt, argsAt + closingParen(text.slice(argsAt)))) };
  });

  const emit = (
    method: string,
    rawPath: string,
    ownGuards: string[],
    facts: HandlerFacts,
    span: { start: number; end: number },
  ) => {
    const guards = [...routerUses.filter((u) => u.line < span.start).flatMap((u) => u.guards), ...ownGuards];
    for (const { path, binding } of expand(rawPath, bindings)) {
      for (const prefix of filePrefixes) {
        const full = normalizePath(prefix + (path.startsWith("/") ? path : "/" + path));
        if (!full || isAssetPath(full)) continue;
        routes.push({ method: method.toLowerCase(), path: full, file: rel, guards, ...facts, binding, span });
      }
    }
  };

  matches.forEach((m, i) => {
    const rawPath = m[3] ?? m[4] ?? m[5] ?? "";
    const afterAt = m.index! + m[0].length;
    const afterPath = text.slice(afterAt, matches[i + 1]?.index ?? text.length);
    const callEnd = closingParen(afterPath);
    const span = { start: lineAt(text, m.index!), end: lineAt(text, afterAt + callEnd) };
    const handlerAt = afterPath.search(HANDLER_START);

    if (handlerAt >= 0 && handlerAt < callEnd) {
      // inline handler: facts come from the handler's own body
      emit(m[2]!, rawPath, guardsOf(afterPath.slice(0, handlerAt)), viewAndRedirects(afterPath.slice(handlerAt, callEnd)), span);
      return;
    }
    // handler by reference: last argument is the handler, the rest are guards
    const tokens = guardsOf(afterPath.slice(0, callEnd));
    const ref = tokens.pop();
    const handler = ref && !ref.startsWith("...") ? referencedHandler(ref, abs, text) : undefined;
    emit(m[2]!, rawPath, tokens, handler ? viewAndRedirects(handler.body) : NO_FACTS, span);
  });

  for (const t of text.matchAll(ROUTE_TABLE_START)) {
    const afterBrace = t.index! + 1;
    const objectEnd = afterBrace + closingParen(text.slice(afterBrace), "{", "}");
    const rest = text.slice(t.index! + t[0].length, objectEnd);
    // keys before the handler are the entry's own flags; the handler body may hold anything
    const handlerAt = rest.search(/\b(?:async\s+)?handler\s*[:(]/);
    const head = handlerAt >= 0 ? rest.slice(0, handlerAt) : rest;
    const guards = [...head.matchAll(/\b(\w+)\s*:\s*true\b/g)].map((g) => g[1]!);
    const ref = rest.match(/\bhandler\s*:\s*([A-Za-z_$][\w$.]*)\s*(?:[,}\n]|$)/)?.[1];
    let facts = NO_FACTS;
    if (ref && ref !== "async" && ref !== "function") {
      const handler = referencedHandler(ref, abs, text);
      if (handler) facts = viewAndRedirects(handler.body);
    } else if (handlerAt >= 0) {
      facts = viewAndRedirects(rest.slice(handlerAt)); // inline arrow, function value or method
    }
    const span = { start: lineAt(text, t.index!), end: lineAt(text, objectEnd) };
    emit(t[1]!, t[2] ?? t[3] ?? t[4] ?? "", guards, facts, span);
  }
  return routes;
}
