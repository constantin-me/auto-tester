import { extname, join, relative } from "node:path";
import { readText, walk } from "../bootstrap/source.js";
import { touchedBaseLines, type Hunk } from "../diff/git.js";

/**
 * Non-code changes (PER-63): translation strings and static assets.
 *
 *   locale  a changed key in locales/*.json reaches the templates and handlers that call
 *           t('that.key') with a literal key; a key nothing references that way (removed,
 *           unused, or only reached through t(variable)) maps to no flow
 *   asset   a changed file under public/ reaches the templates that link it
 */

export const isLocaleFile = (path: string) => extname(path) === ".json" && /(^|\/)locales\//.test(path);
export const isStaticAsset = (path: string) => /(^|\/)public\//.test(path) && /\.(css|js|mjs)$/.test(path);

/** Key path of every line of a pretty-printed JSON document (one key per line). */
export function keyPathsByLine(json: string): Map<number, string> {
  const out = new Map<number, string>();
  const stack: string[] = [];
  json.split("\n").forEach((line, i) => {
    const m = line.match(/^\s*"((?:[^"\\]|\\.)*)"\s*:\s*(.*)$/);
    if (m) {
      const path = [...stack, m[1]!].join(".");
      out.set(i + 1, path);
      if (/^\{\s*$/.test(m[2]!.trim())) stack.push(m[1]!);
    } else if (/^\s*\}/.test(line)) {
      stack.pop();
    }
  });
  return out;
}

/** Keys whose value a locale hunk changes, adds or removes. */
export function changedKeys(baseJson: string, hunk: Hunk): string[] {
  const byLine = keyPathsByLine(baseJson);
  const touched = touchedBaseLines(hunk);
  const keys = new Set<string>();
  for (const l of touched.removed) {
    const k = byLine.get(l);
    if (k) keys.add(k);
  }
  // added lines: their own key, under the parent of the line they were inserted after
  for (const p of touched.insertedAfter) {
    const parent = (byLine.get(p) ?? "").split(".").slice(0, -1).join(".");
    for (const line of hunk.text.split("\n")) {
      const m = line.match(/^\+\s*"((?:[^"\\]|\\.)*)"\s*:/);
      if (m) keys.add(parent ? `${parent}.${m[1]}` : m[1]!);
    }
  }
  return [...keys];
}

const T_CALL = /\b(?:req\.)?t\(\s*['"`]([\w.-]+)['"`]/g;

export interface KeyUsage {
  /** repo-relative template files calling t('key') */
  templates: string[];
  /** repo-relative code files and 1-based lines calling t('key') / req.t('key') */
  code: { file: string; line: number }[];
}

/** Where each translation key is used with a literal key, across templates and code. */
export function keyUsageIndex(appRoot: string): Map<string, KeyUsage> {
  const idx = new Map<string, KeyUsage>();
  const at = (k: string) => {
    if (!idx.has(k)) idx.set(k, { templates: [], code: [] });
    return idx.get(k)!;
  };
  for (const abs of walk(appRoot)) {
    const ext = extname(abs);
    if (ext !== ".ejs" && ext !== ".ts" && ext !== ".js") continue;
    if (abs.includes(`${join(appRoot, "public")}`)) continue;
    const text = readText(abs);
    if (!text || !text.includes("t(")) continue;
    const rel = relative(appRoot, abs);
    if (ext === ".ejs") {
      for (const m of text.matchAll(T_CALL)) {
        const u = at(m[1]!);
        if (!u.templates.includes(rel)) u.templates.push(rel);
      }
    } else {
      text.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(T_CALL)) at(m[1]!).code.push({ file: rel, line: i + 1 });
      });
    }
  }
  return idx;
}

/** Templates that reference a static asset by its public URL path. */
export function assetReferences(appRoot: string, assetRel: string): string[] {
  const url = "/" + assetRel.replace(/^.*?public\//, "");
  const refs: string[] = [];
  for (const abs of walk(appRoot)) {
    if (extname(abs) !== ".ejs") continue;
    if ((readText(abs) ?? "").includes(url)) refs.push(relative(appRoot, abs));
  }
  return refs;
}
