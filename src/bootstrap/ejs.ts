import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readText, literalsOf } from "./source.js";
import { normalizePath, isAssetPath, PARAM } from "./paths.js";

/**
 * Static extraction of navigation from EJS templates: where each view links
 * (href), posts (form action) and calls (fetch). This is what turns the mind-map
 * from isolated routes into an actual flow graph.
 */

export type LinkKind = "navigate" | "submit" | "api";

export interface ViewLink {
  kind: LinkKind;
  method: string; // lowercase
  path: string; // normalized
  /** repo-relative file the link was found in (view or partial) */
  file: string;
}

/** Base-URL-only tags vanish; any other EJS output tag is an unknown dynamic piece. */
const BASE_TAG = /<%[=-]\s*(?:baseUrl|BASE_URL|basePath)\s*(?:\|\|\s*['"]\/['"]\s*)?%>/g;
const EJS_TAG = /<%[\s\S]*?%>/g;
const INCLUDE_RE = /include\(\s*['"]([^'"]+)['"]/g;

/** Template dirs from `app.set('views', ...)` in the entry file, else ["views"]. */
export function detectViewDirs(entryText: string | undefined): string[] {
  const m = entryText?.match(/\.set\(\s*['"]views['"]\s*,([\s\S]*?)\)\s*;/);
  if (!m) return ["views"];
  const dirs = [...m[1]!.matchAll(/join\(\s*__dirname\s*,([^)]*)\)/g)]
    .map((j) => literalsOf(j[1]!))
    .filter(Boolean);
  if (dirs.length) return dirs;
  const plain = literalsOf(m[1]!);
  return plain ? [plain] : ["views"];
}

export class ViewIndex {
  constructor(
    private readonly appRoot: string,
    private readonly viewDirs: string[],
  ) {}

  /** `res.render('add')` -> abs path of add.ejs in the first view dir that has it */
  resolveView(name: string): string | undefined {
    const file = name.endsWith(".ejs") ? name : `${name}.ejs`;
    return this.viewDirs.map((d) => join(this.appRoot, d, file)).find((p) => existsSync(p));
  }

  /** include('partials/header') from `fromAbs`: relative to the including file first, then view dirs */
  resolveInclude(fromAbs: string, spec: string): string | undefined {
    const file = spec.endsWith(".ejs") ? spec : `${spec}.ejs`;
    const local = join(dirname(fromAbs), file);
    if (existsSync(local)) return local;
    return this.resolveView(spec);
  }

  /** Direct includes of a template. */
  includesOf(abs: string): string[] {
    const text = readText(abs) ?? "";
    return [...text.matchAll(INCLUDE_RE)]
      .map((m) => this.resolveInclude(abs, m[1]!))
      .filter((p): p is string => !!p && p !== abs);
  }

  /** All templates reachable from `abs` via include (excluding `abs`). */
  closure(abs: string, seen = new Set<string>()): Set<string> {
    for (const inc of this.includesOf(abs)) {
      if (seen.has(inc)) continue;
      seen.add(inc);
      this.closure(inc, seen);
    }
    return seen;
  }

  /** Repo-relative template files a view renders: the view itself, then every partial it includes. */
  chain(view: string): string[] {
    const abs = this.resolveView(view);
    if (!abs) return [];
    return [abs, ...this.closure(abs)].map((p) => relative(this.appRoot, p));
  }

  /** Links found directly in one template file. */
  linksIn(abs: string): ViewLink[] {
    const raw = readText(abs);
    if (!raw) return [];
    const text = raw.replace(BASE_TAG, "").replace(EJS_TAG, PARAM);
    const file = relative(this.appRoot, abs);
    const links: ViewLink[] = [];
    const add = (kind: LinkKind, method: string, rawPath: string) => {
      const path = normalizePath(rawPath);
      if (!path || isAssetPath(path) || path === PARAM) return;
      links.push({ kind, method, path, file });
    };

    for (const m of text.matchAll(/<a\b[^>]*?\bhref=["']([^"']*)["']/g)) add("navigate", "get", m[1]!);

    for (const m of text.matchAll(/<form\b([^>]*)>/g)) {
      const attrs = m[1]!;
      const action = attrs.match(/\baction=["']([^"']*)["']/)?.[1];
      if (!action) continue;
      const method = (attrs.match(/\bmethod=["'](\w+)["']/)?.[1] ?? "get").toLowerCase();
      add(method === "get" ? "navigate" : "submit", method, action);
    }

    // client-side navigation with a literal target: location.href = '/x', location.assign('/x')
    for (const m of text.matchAll(/\blocation(?:\.href)?\s*=\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)|\blocation\.(?:assign|replace)\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g)) {
      add("navigate", "get", m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? "");
    }

    // `fetch('/import/' + id, …)`: a concatenated tail is one more dynamic piece
    for (const m of text.matchAll(/fetch\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)(\s*\+\s*[A-Za-z_$(])?/g)) {
      const lookahead = text.slice(m.index!, m.index! + 300);
      const method = (lookahead.match(/method\s*:\s*['"`](\w+)['"`]/)?.[1] ?? "get").toLowerCase();
      add("api", method, (m[1] ?? m[2] ?? m[3] ?? "") + (m[4] ? PARAM : ""));
    }
    return links;
  }
}
