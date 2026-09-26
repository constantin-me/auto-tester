import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, type Config } from "../config/config.js";
import { CommittedFileStore } from "../store/store.js";
import { staticCrawl } from "../bootstrap/crawl.js";
import type { MindMap } from "../mindmap/schema.js";

/**
 * Evaluation workspace: for each commit, the target app exactly as it was at the
 * commit's PARENT, plus a mind-map crawled from that tree. Detection then runs on
 * one consistent code state instead of mixing the parent's diff with HEAD's code.
 *
 * Trees are extracted with `git archive` into eval/.cache (never touching the
 * app's working tree); maps go to eval/maps/<sha>/ (never the HEAD map).
 */

export const EVAL_DIR = resolve(import.meta.dirname, "../../eval");

export interface EvalCommit {
  sha: string;
  split: "train" | "dev" | "heldout" | "heldout2" | "heldout3";
  why: string;
}

export interface EvalSpec {
  repo: string;
  appRoot: string; // absolute
  config: Config;
  commits: EvalCommit[];
}

/**
 * `splits` limits which commits are loaded, e.g. ["train", "dev"] while a held-out
 * batch must stay untouched until the design is frozen.
 */
export function loadSpec(splits?: string[]): EvalSpec {
  const raw = JSON.parse(readFileSync(join(EVAL_DIR, "commits.json"), "utf8"));
  const { config } = loadConfig(resolve(EVAL_DIR, raw.config));
  const commits: EvalCommit[] = raw.commits.filter((c: EvalCommit) => !splits || splits.includes(c.split));
  return { repo: raw.repo, appRoot: resolve(EVAL_DIR, raw.appRoot), config, commits };
}

/** `--splits a,b` from argv, or undefined for all. */
export function splitsArg(argv: string[]): string[] | undefined {
  const i = argv.indexOf("--splits");
  return i >= 0 && argv[i + 1] ? argv[i + 1]!.split(",") : undefined;
}

const SHA = /^[0-9a-f]{7,40}$/;

export function treeDir(sha: string): string {
  return join(EVAL_DIR, ".cache", "trees", sha);
}

export function mapStore(sha: string): CommittedFileStore {
  return new CommittedFileStore(join(EVAL_DIR, "maps"), sha);
}

/** Extract `<sha>~1` of the app into eval/.cache/trees/<sha>, once. */
export function extractParentTree(appRoot: string, sha: string): string {
  if (!SHA.test(sha)) throw new Error(`not a short/long sha: ${sha}`);
  const dir = treeDir(sha);
  if (existsSync(join(dir, ".extracted"))) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tar = join(EVAL_DIR, ".cache", `${sha}.tar`);
  execFileSync("git", ["-C", appRoot, "archive", "--format=tar", "-o", tar, `${sha}~1`]);
  execFileSync("tar", ["-xf", tar, "-C", dir]);
  rmSync(tar);
  execFileSync("touch", [join(dir, ".extracted")]);
  return dir;
}

/** Crawl the parent tree into its eval-only map. */
export function bootstrapTree(spec: EvalSpec, sha: string): MindMap {
  const dir = extractParentTree(spec.appRoot, sha);
  const { map } = staticCrawl(dir, spec.repo, spec.config.crawler);
  map.commit = `${sha}~1`;
  mapStore(sha).save(map);
  return map;
}
