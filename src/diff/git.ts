import { execFileSync } from "node:child_process";
import type { ChangeContext, ChangedFile } from "../jev/judgments.js";

/**
 * Read a change from git into the shape Jev triage consumes.
 * execFile (no shell) + a strict ref check: refs come from CLI args / CI env.
 */

const REF = /^[A-Za-z0-9._\/~^@{}-]+$/;

function assertRef(ref: string): void {
  if (!REF.test(ref) || ref.startsWith("-")) throw new Error(`refusing suspicious git ref: ${JSON.stringify(ref)}`);
}

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Split a multi-file unified diff into per-file patches. */
export function splitPatch(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  for (const chunk of chunks) {
    const path = chunk.match(/^diff --git a\/(\S+) b\/(\S+)/)?.[2];
    if (path) files.push({ path, patch: chunk });
  }
  return files;
}

export interface Hunk {
  /** first line on the base (old) side, 1-based */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** the hunk including its @@ header */
  text: string;
}

/** Hunks of one file's patch. */
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  const parts = patch.split(/^(?=@@ )/m).filter((p) => p.startsWith("@@ "));
  for (const text of parts) {
    const m = text.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    hunks.push({
      oldStart: Number(m[1]),
      oldLines: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLines: m[4] === undefined ? 1 : Number(m[4]),
      text: text.replace(/\n$/, ""),
    });
  }
  return hunks;
}

/**
 * What a hunk touches on the base side: removed lines, and the base lines after
 * which new lines were inserted. Context lines are NOT touched — counting them
 * blames a neighbouring function for an unrelated addition.
 */
export function touchedBaseLines(h: Hunk): { removed: number[]; insertedAfter: number[] } {
  const removed: number[] = [];
  const insertedAfter: number[] = [];
  let old = h.oldStart;
  let prev = "";
  for (const line of h.text.split("\n").slice(1)) {
    const tag = line[0];
    if (tag === "\\") continue; // "\ No newline at end of file"
    if (tag === "-") removed.push(old++);
    else if (tag === "+") {
      if (prev !== "+") insertedAfter.push(old - 1);
    } else old++;
    prev = tag ?? "";
  }
  return { removed, insertedAfter };
}

/** Does a base-side span [start, end] contain a touched line or an insertion strictly inside it? */
export function spanTouched(span: { start: number; end: number }, t: { removed: number[]; insertedAfter: number[] }): boolean {
  return t.removed.some((l) => l >= span.start && l <= span.end) || t.insertedAfter.some((p) => p >= span.start && p < span.end);
}

/** A file's content at a revision; undefined when it did not exist there. */
export function fileAt(repoDir: string, rev: string, path: string): string | undefined {
  assertRef(rev);
  if (path.startsWith("-") || path.includes("..")) throw new Error(`refusing suspicious path: ${JSON.stringify(path)}`);
  try {
    return execFileSync("git", ["-C", repoDir, "show", `${rev}:${path}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/** One commit: its message as summary, its patch per file. */
export function readCommit(repoDir: string, rev: string): ChangeContext {
  assertRef(rev);
  return {
    summary: git(repoDir, ["log", "-1", "--format=%B", rev, "--"]).trim(),
    files: splitPatch(git(repoDir, ["show", "--format=", "--patch", rev, "--"])),
  };
}

/** A PR-style range: everything on `head` since it forked from `base`. */
export function readRange(repoDir: string, base: string, head: string, summary = ""): ChangeContext {
  assertRef(base);
  assertRef(head);
  return { summary, files: splitPatch(git(repoDir, ["diff", `${base}...${head}`, "--"])) };
}

/** Uncommitted changes (staged and unstaged) against HEAD: a local "check my work" run. */
export function readWorkingTree(repoDir: string): ChangeContext {
  return { summary: "uncommitted working-tree changes", files: splitPatch(git(repoDir, ["diff", "HEAD", "--"])) };
}
