import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Read-only view over the target app's source tree. */

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

export function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(abs, acc);
    else acc.push(abs);
  }
  return acc;
}

export function readText(abs: string): string | undefined {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

/** Resolve an import specifier the way a TS project run by tsx would (`./x.js` -> `./x.ts`). */
export function resolveModule(fromDir: string, spec: string): string | undefined {
  const base = join(fromDir, spec);
  const stem = base.replace(/\.(js|mjs|cjs|ts)$/, "");
  const candidates = [base, `${stem}.ts`, `${stem}.js`, join(stem, "index.ts"), join(stem, "index.js")];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}

/** All string literals in an expression, concatenated: `BASE_URL + '/admin'` -> `/admin`. */
export function literalsOf(expr: string): string {
  return [...expr.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "").join("");
}

/**
 * Blank out // and /* *\/ comments, keeping every newline so line numbers stay
 * valid. Strings are respected, so `'http://x'` survives. Parsing code after this
 * keeps an apostrophe in a comment ("a seller's name") from opening a fake string.
 */
export function stripComments(text: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = text[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) out += text[i++] === "\n" ? "\n" : "";
      i++;
    } else out += c;
  }
  return out;
}
