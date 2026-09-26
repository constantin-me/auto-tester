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
