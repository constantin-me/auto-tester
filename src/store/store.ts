import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { MindMap, emptyMindMap } from "../mindmap/schema.js";

/**
 * Pluggable store adapter (plan Q11).
 * Source of truth default = committed file in the target repo, so every
 * mind-map change shows up as a reviewable diff in the PR.
 * ci-artifact / local-disk are the same on-disk format, different location;
 * a v2 central indexer projects committed maps into a cross-repo read-model.
 */
export interface MindMapStore {
  load(repo: string): MindMap;
  save(map: MindMap): void;
  /** write a derived file (e.g. mindmap.mmd) next to the map; returns its absolute path */
  saveArtifact(name: string, content: string): string;
  /** absolute path of the map file, for logging / PR-diff visibility */
  location(): string;
}

export class CommittedFileStore implements MindMapStore {
  private readonly file: string;
  constructor(baseDir: string, dir: string) {
    this.file = resolve(baseDir, dir, "mindmap.json");
  }
  location(): string {
    return this.file;
  }
  load(repo: string): MindMap {
    if (!existsSync(this.file)) return emptyMindMap(repo);
    const raw = JSON.parse(readFileSync(this.file, "utf8"));
    return MindMap.parse(raw);
  }
  save(map: MindMap): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(this.file, JSON.stringify(map, null, 2) + "\n", "utf8");
  }
  saveArtifact(name: string, content: string): string {
    const target = join(this.file, "..", name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content, "utf8");
    return resolve(target);
  }
}

export function makeStore(
  backend: "committed-file" | "ci-artifact" | "local-disk",
  baseDir: string,
  dir: string,
): MindMapStore {
  // committed-file / local-disk share behavior today; they differ only in
  // whether `dir` is inside the repo. ci-artifact will diverge in M3 (cache).
  switch (backend) {
    case "committed-file":
    case "local-disk":
    case "ci-artifact":
      return new CommittedFileStore(baseDir, dir);
  }
}
