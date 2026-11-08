import { existsSync } from "node:fs";
import { loadConfig } from "../config/config.js";
import { makeStore } from "../store/store.js";
import { toMermaid } from "../mindmap/mermaid.js";
import { hasCriteria, listAssertions, setPinned, setPinnedByFilter, type AssertionFilter, type AssertionRow } from "../mindmap/pin.js";

/**
 * PER-43: pinning workflow. Humans decide ground truth by pinning assertions; pinned assertions are
 * immutable to agents and the comparator treats them as ground truth. Pinning keeps `origin`.
 *
 * Usage (no env file needed):
 *   npm run pin -- <config> list [--node <id|glob>] [--pinned|--unpinned] [--min-severity N] [--origin X] [--grep text] [--json]
 *   npm run pin -- <config> pin|unpin <assertionId...>                 exact ids
 *   npm run pin -- <config> pin|unpin --node <id|glob> [--min-severity N] [--grep text] [--origin X] [--dry-run]
 *                                                                       bulk by filter; needs at least one filter
 * --node is repeatable. Node globs use `*` (e.g. `node:add-*`). Exit code 1 if any id was not found.
 * --dry-run shows what would change without saving.
 */

const ORIGINS = ["static-crawl", "llm-author", "qa-observed", "human"] as const;
const VALUE_FLAGS = new Set(["--node", "--min-severity", "--origin", "--grep"]);
const BOOL_FLAGS = new Set(["--pinned", "--unpinned", "--json", "--dry-run"]);

const usage = () => {
  console.error(
    "usage: npm run pin -- <config.json> list [--node <id|glob>] [--pinned|--unpinned] [--min-severity N] [--origin X] [--grep text] [--json]\n" +
      "       npm run pin -- <config.json> pin|unpin <assertionId...>\n" +
      "       npm run pin -- <config.json> pin|unpin --node <id|glob> [--min-severity N] [--grep text] [--origin X] [--dry-run]",
  );
  process.exit(2);
};
const fail = (msg: string): never => {
  console.error(`[pin] ${msg}`);
  process.exit(2);
};

function parse(argv: string[]) {
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) fail(`${a} needs a value`);
      values.set(a, [...(values.get(a) ?? []), v!]);
    } else if (BOOL_FLAGS.has(a)) bools.add(a);
    else if (a.startsWith("--")) fail(`unknown flag ${a}`);
    else positional.push(a);
  }
  return { positional, values, bools };
}

const line = (r: AssertionRow) => {
  const a = r.assertion;
  const check = a.check ? ` check=${a.check.kind}:${a.check.value}` : "";
  return `  ${a.pinned ? "[P]" : "   "} ${a.severityIfBroken} ${a.id}  ${a.expectation}${check}`;
};

function printGrouped(rows: AssertionRow[]) {
  let last = "";
  for (const r of rows) {
    const key = `${r.ownerKind}:${r.ownerId}`;
    if (key !== last) console.log(r.ownerKind === "edge" ? `edge ${r.ownerId}` : r.ownerId);
    last = key;
    console.log(line(r));
  }
}

function main() {
  const { positional, values, bools } = parse(process.argv.slice(2));
  const [configArg, command, ...ids] = positional;
  if (!configArg || !command || !existsSync(configArg)) usage();
  if (!["list", "pin", "unpin"].includes(command!)) usage();

  const filter: AssertionFilter = {};
  if (values.has("--node")) filter.nodes = values.get("--node")!;
  if (values.has("--origin")) {
    const o = values.get("--origin")![0]!;
    if (!(ORIGINS as readonly string[]).includes(o)) fail(`--origin must be one of ${ORIGINS.join(", ")}`);
    filter.origin = o as (typeof ORIGINS)[number];
  }
  if (values.has("--min-severity")) {
    const n = Number(values.get("--min-severity")![0]);
    if (!(Number.isInteger(n) && n >= 0 && n <= 5)) fail("--min-severity needs an integer 0..5");
    filter.minSeverity = n;
  }
  if (values.has("--grep")) filter.grep = values.get("--grep")![0]!;
  if (bools.has("--pinned") && bools.has("--unpinned")) fail("--pinned and --unpinned are mutually exclusive");

  const { config, baseDir } = loadConfig(configArg!);
  const store = makeStore(config.store.backend, baseDir, config.store.dir);
  const map = store.load(config.repo);
  if (!map.nodes.length) fail("mind-map is empty; run bootstrap first.");

  if (command === "list") {
    if (bools.has("--pinned")) filter.pinned = true;
    if (bools.has("--unpinned")) filter.pinned = false;
    const rows = listAssertions(map, filter);
    if (bools.has("--json")) {
      console.log(
        JSON.stringify(
          rows.map((r) => ({ ownerKind: r.ownerKind, ownerId: r.ownerId, ...r.assertion })),
          null,
          2,
        ),
      );
      return;
    }
    printGrouped(rows);
    const pinned = rows.filter((r) => r.assertion.pinned).length;
    const owners = new Set(rows.map((r) => `${r.ownerKind}:${r.ownerId}`)).size;
    console.log(`${rows.length} assertions on ${owners} nodes/edges (${pinned} pinned, ${rows.length - pinned} unpinned)`);
    return;
  }

  const pin = command === "pin";
  if (bools.has("--pinned") || bools.has("--unpinned")) fail("--pinned/--unpinned only apply to list");
  const byFilter = hasCriteria(filter);
  if (ids.length && byFilter) fail("give either assertion ids or filters, not both");
  if (!ids.length && !byFilter) fail(`${command} needs assertion ids or at least one filter (refusing to ${command} everything)`);

  const { map: next, report } = ids.length ? setPinned(map, ids, pin) : setPinnedByFilter(map, filter, pin);

  const byId = new Map(listAssertions(map).map((r) => [r.assertion.id, r]));
  const verb = pin ? "pinned" : "unpinned";
  const dry = bools.has("--dry-run");
  for (const id of report.changed) console.log(`${dry ? "would be " : ""}${verb}: ${byId.get(id)!.ownerId}  ${id}  ${byId.get(id)!.assertion.expectation}`);
  for (const id of report.notFound) console.error(`not found: ${id}`);
  console.log(`[pin] ${dry ? "dry run, nothing saved: " : ""}${report.changed.length} changed, ${report.alreadyInState.length} already ${verb}, ${report.notFound.length} not found`);

  if (!dry && report.changed.length) {
    store.save({ ...next, generatedAt: new Date().toISOString() });
    store.saveArtifact("mindmap.mmd", toMermaid(next));
    console.log(`[pin] wrote ${store.location()}`);
  }
  if (report.notFound.length) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error("[pin] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
