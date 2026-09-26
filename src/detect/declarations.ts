import { stripComments } from "../bootstrap/source.js";

/**
 * Named declarations in a JS/TS source text with their line spans:
 * `function f`, `async function f`, `const f = …`, at any nesting depth.
 * Text-level (no parser) on purpose: works on any version of any file and is
 * good enough to answer "which named function encloses this hunk?".
 */

export interface Declaration {
  name: string;
  /** 1-based inclusive */
  start: number;
  end: number;
  exported: boolean;
}

/**
 * Function-like declarations only. Plain `const x = value` locals are NOT symbols:
 * treating them as such makes every mention of a common word (`plugin`, `item`)
 * look like a caller.
 */
const DECL_RE =
  /(^|\n)([ \t]*)(export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=>{]+)?=>|[A-Za-z_$][\w$]*\s*=>))/g;

export function declarations(source: string): Declaration[] {
  const text = stripComments(source); // lines kept; see stripComments

  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const out: Declaration[] = [];
  for (const m of text.matchAll(DECL_RE)) {
    const name = m[4] ?? m[5];
    if (!name) continue;
    const at = m.index! + m[1]!.length;
    const endOffset = statementEnd(text, m.index! + m[0].length);
    out.push({ name, start: lineOf(at), end: lineOf(endOffset), exported: !!m[3] });
  }
  return out;
}

/** End of the statement starting at `from`: the brace block if one opens before `;`, else the `;`/newline. */
function statementEnd(text: string, from: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0 && c === "}") {
        // a block closed at top level: the declaration ends at the end of this statement
        const rest = text.slice(i + 1);
        const semi = rest.search(/^[ \t)]*;/);
        return semi === 0 ? i + 1 + rest.indexOf(";") : i;
      }
      if (depth < 0) return i;
    } else if (depth === 0 && (c === ";" || (c === "\n" && !/[=,(+\-*/?:.|&]\s*$/.test(text.slice(from, i))))) return i;
  }
  return text.length;
}

export { stripComments };

/** Smallest declaration whose span overlaps [start, end]. */
export function enclosing(decls: Declaration[], start: number, end: number): Declaration | undefined {
  return decls
    .filter((d) => d.start <= end && d.end >= start)
    .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
}
