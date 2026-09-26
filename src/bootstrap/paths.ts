/**
 * URL path helpers shared by the route extractor and the view link extractor.
 *
 * Unknown dynamic pieces are normalized to the literal token `:param`, so a
 * link like `/dvd/<%= item._id %>` becomes `/dvd/:param` and can be matched
 * against the route pattern `/dvd/:id`.
 */

export const PARAM = ":param";

/** `${BASE_URL}`, `${jsBaseUrl}`, `${baseUrl}` … at the start of a template string */
const LEADING_BASE_TEMPLATE = /^\$\{[^}]*base[^}]*\}/i;
const ASSET_EXT = /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|json|webmanifest|txt|xml)$/i;

/** Normalize a raw path (possibly templated) into a comparable route path. `undefined` = not a local path. */
export function normalizePath(raw: string): string | undefined {
  let p = raw.trim().replace(LEADING_BASE_TEMPLATE, "");
  p = p.replace(/\$\{[^}]*\}/g, PARAM);
  p = p.split(/[?#]/)[0] ?? "";
  if (!p.startsWith("/")) return undefined;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/$/, "");
  return p;
}

export function isAssetPath(p: string): boolean {
  return ASSET_EXT.test(p) || p.startsWith("/vendor/") || p.startsWith("/ressources/") || p.startsWith("/styles/");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Route pattern `/dvd/:id` -> regex matching concrete-or-normalized paths. */
export function routeRegex(pattern: string): RegExp {
  const src = pattern
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : escapeRe(seg).replace(/:[A-Za-z_]\w*/g, "[^/]+")))
    .join("/");
  return new RegExp(`^${src}$`);
}

/**
 * Normalized link `/search-:param` -> regex, so a partially-dynamic link can find `/search-books`.
 * A piece glued to a preceding literal and followed by `/` (`/api${routePrefix}/…`) may itself
 * be a whole `/segment`, so it also matches `/api/album/…`.
 */
export function linkRegex(link: string): RegExp {
  const parts = link.split(PARAM);
  const src = parts
    .map((part, i) => {
      if (i === 0) return escapeRe(part);
      const prev = parts[i - 1]!;
      const glued = prev.length > 0 && !prev.endsWith("/") && part.startsWith("/");
      return (glued ? "(?:/[^/]+|[^/]+)" : "[^/]+") + escapeRe(part);
    })
    .join("");
  return new RegExp(`^${src}$`);
}

/** Number of dynamic segments; fewer = more specific. */
export function paramCount(p: string): number {
  return (p.match(/:[A-Za-z_]\w*/g) ?? []).length;
}
