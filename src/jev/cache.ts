import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Answer cache for Jev judgments. A cached answer is valid only for the exact question
 * set, the exact state sent and the configured model: change any of them and the
 * key changes. Makes reruns of the same change reproducible (Jev can vary slightly on
 * borderline flows between runs) and free.
 *
 * It does not make a borderline answer right, only stable.
 */
export class JevCache<T> {
  private readonly entries: Record<string, T>;
  private dirty = false;
  hits = 0;
  misses = 0;

  constructor(
    /** null: keep answers for this run only, persist nothing */
    private readonly file: string | null,
    private readonly model: string,
  ) {
    this.entries = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }

  key(kind: string, questions: unknown, state: unknown): string {
    return createHash("sha256")
      .update(kind)
      .update("\0" + this.model)
      .update("\0" + JSON.stringify(questions))
      .update("\0" + JSON.stringify(state))
      .digest("hex");
  }

  /** would this key be answered without a call? (lets a budget gate let free work through) */
  has(key: string): boolean {
    return key in this.entries;
  }

  async getOrAsk(key: string, ask: () => Promise<T>): Promise<T> {
    if (key in this.entries) {
      this.hits++;
      return this.entries[key]!;
    }
    this.misses++;
    const value = await ask();
    this.entries[key] = value;
    this.dirty = true;
    return value;
  }

  save(): void {
    if (!this.dirty || !this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.entries) + "\n");
    this.dirty = false;
  }
}
