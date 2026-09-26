import { loadSpec, bootstrapTree, mapStore, splitsArg } from "../eval/trees.js";

/**
 * Prepare the evaluation workspace: parent tree + mind-map per commit.
 * Prints each map's page/endpoint flows so labels can be written against them.
 * Does NOT run detection: labels must be written before the detector sees a commit.
 */
const spec = loadSpec(splitsArg(process.argv.slice(2)));
for (const c of spec.commits) {
  const map = bootstrapTree(spec, c.sha);
  const flows = map.nodes.filter((n) => n.kind !== "synthetic");
  console.log(`${c.sha} [${c.split}] ${flows.length} flows, ${map.edges.length} edges -> ${mapStore(c.sha).location()}`);
}
