import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

/**
 * Per-repo configuration (plan Q1/Q3/Q4/Q8/Q11/Q15).
 * Lives in the target repo as `autotester.config.json`.
 */

export const AuthRecipe = z.object({
  kind: z.enum(["form", "token", "none"]).default("none"),
  /** form login: URL of the login page, relative to env.baseUrl */
  loginPath: z.string().optional(),
  /** form login: field selectors + values (values may be ${ENV_VAR}) */
  fields: z.record(z.string()).optional(),
  /** form login: selector to submit */
  submitSelector: z.string().optional(),
  /** token: header name + value (value may be ${ENV_VAR}) */
  header: z.object({ name: z.string(), value: z.string() }).optional(),
});
export type AuthRecipe = z.infer<typeof AuthRecipe>;

/**
 * Expands template-literal route paths like `/add-${plugin.id}`.
 * Each file matching `from` (one `*` segment allowed) yields one binding of
 * `var`, reading each field from its first `field: 'value'` occurrence.
 */
export const Expansion = z.object({
  var: z.string(),
  from: z.string(),
  fields: z.array(z.string()).min(1),
});
export type Expansion = z.infer<typeof Expansion>;

export const CrawlerConfig = z.object({
  /** file that mounts routers (app.use(prefix, router)), relative to appRoot */
  entry: z.string().optional(),
  /** template dirs relative to appRoot; detected from app.set('views') when omitted */
  viewDirs: z.array(z.string()).optional(),
  expansions: z.array(Expansion).default([]),
  /** a partial included by at least this many views is treated as global navigation */
  globalPartialThreshold: z.number().int().positive().default(5),
});
export type CrawlerConfig = z.infer<typeof CrawlerConfig>;

export const Config = z.object({
  /** identity used to key the mind-map + (v2) central index */
  repo: z.string(),
  /** path to the target app source, relative to this config file */
  appRoot: z.string().default("."),
  /** framework hint steers the static crawler */
  framework: z.enum(["express-ejs", "next", "generic"]).default("generic"),
  crawler: CrawlerConfig.default({}),
  env: z.object({
    /** live/staging base URL the QA drivers hit */
    baseUrl: z.string().url().optional(),
  }),
  auth: AuthRecipe.default({ kind: "none" }),
  budget: z.object({
    /** hard token cap per run; orchestrator stops new spawns past it (plan Q14) */
    maxTokens: z.number().int().positive().default(200_000),
    /**
     * share of maxTokens (0..1) that triage + execution checks may not spend, kept for the
     * browser visits: their Jev calls (observation, severity) would otherwise find nothing left
     */
    reserveForChecks: z.number().min(0).max(1).default(0.3),
  }),
  flakiness: z.object({
    /** retries before a deviation is allowed to be flagged (plan Q15) */
    retryCount: z.number().int().min(0).default(2),
  }),
  jev: z
    .object({
      /** System One model; SDK default is jev-latest */
      model: z.string().optional(),
      /** parallel judgment requests in flight */
      concurrency: z.number().int().positive().default(8),
    })
    .default({}),
  /** LLM enrichment pass (PER-42): labels + expected-behavior assertions, written by Claude */
  enrich: z
    .object({
      /**
       * api         = Anthropic API, ANTHROPIC_API_KEY (works in CI)
       * claude-code = local `claude -p`, covered by the user's Claude subscription (local only)
       */
      backend: z.enum(["api", "claude-code"]).default("api"),
      model: z.string().default("claude-opus-5-5"),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
      /** parallel requests in flight */
      concurrency: z.number().int().positive().default(4),
      /** a node whose handler + templates exceed this is skipped, never truncated */
      maxEvidenceChars: z.number().int().positive().default(100_000),
    })
    .default({}),
  /** browser QA (M4). Read-only unless allowWrites: it runs against a real instance. */
  qa: z
    .object({
      /** pages whose links are harvested to resolve :id params */
      seedPaths: z.array(z.string()).default(["/", "/collection", "/wishlist"]),
      /** 2 = also read the pages the seed pages link to (detail pages link to edit/label pages); denyPaths apply */
      harvestDepth: z.number().int().min(1).max(2).default(1),
      /** never visited, whatever the map says (substring match on the route) */
      denyPaths: z.array(z.string()).default(["/logout", "/login/oidc", "/backup/", "/api/", "/socket.io"]),
      /** endpoints (redirects, downloads, JSON) are skipped unless enabled */
      visitEndpoints: z.boolean().default(false),
      /** submitting forms / non-GET actions; off by default */
      allowWrites: z.boolean().default(false),
      /**
       * extra Chrome flags, e.g. ["--no-sandbox"] on CI runners whose kernel blocks the
       * Chrome sandbox (ubuntu-24.04 AppArmor). Opt-in: the sandbox stays on by default.
       */
      launchArgs: z.array(z.string()).default([]),
      /**
       * the instance at env.baseUrl is throwaway (e.g. a docker compose project of its own):
       * required before `qa:seed` may wipe and re-seed it. Never set it for a real instance.
       */
      disposable: z.boolean().default(false),
      /** fixture loader: POST `file` (relative to the config) to `path` on a fresh instance */
      seed: z
        .object({
          path: z.string(),
          file: z.string(),
          contentType: z.string().default("application/json"),
        })
        .optional(),
      concurrency: z.number().int().positive().default(4),
      /** where run evidence (screenshots, observations) is written, relative to the config */
      runsDir: z.string().default("../.autotester/runs"),
    })
    .default({}),
  store: z.object({
    /** where the mind-map lives (plan Q11) */
    backend: z.enum(["committed-file", "ci-artifact", "local-disk"]).default("committed-file"),
    /** dir for committed-file backend, relative to this config file */
    dir: z.string().default(".autotester/mindmap"),
  }),
});
export type Config = z.infer<typeof Config>;

/** Load + validate a config file, resolving relative paths against its location. */
export function loadConfig(configPath: string): { config: Config; baseDir: string } {
  const abs = resolve(configPath);
  const raw = JSON.parse(readFileSync(abs, "utf8"));
  const config = Config.parse(raw);
  return { config, baseDir: dirname(abs) };
}
