import type { MindMap, FlowNode } from "./schema.js";

/**
 * Render the mind-map as a Mermaid flowchart for human review. Stored next to
 * mindmap.json so the PR diff shows the flow change visually, not just as JSON.
 *
 * Drawn:   navigate edges (-->), submit edges (==>, labelled with the POST).
 * Folded:  api calls and unlinked actions become a count on their node —
 *          as self-loops they bury the flow. The header comment says so.
 */
export function toMermaid(map: MindMap): string {
  const mid = new Map(map.nodes.map((n) => [n.id, safeId(n.id)]));
  const idOf = (id: string) => mid.get(id) ?? safeId(id);

  const folded = new Map<string, { api: number; unlinked: number }>();
  for (const e of map.edges) {
    if (e.kind !== "api" && e.kind !== "unlinked") continue;
    const f = folded.get(e.from) ?? { api: 0, unlinked: 0 };
    f[e.kind]++;
    folded.set(e.from, f);
  }
  const apiTotal = map.edges.filter((e) => e.kind === "api").length;
  const unlinkedTotal = map.edges.filter((e) => e.kind === "unlinked").length;

  const lines: string[] = [
    `%% ${map.repo} — generated ${map.generatedAt}. Do not edit; regenerate with bootstrap.`,
    `%% nodes=${map.nodes.length} edges=${map.edges.length} (folded: ${apiTotal} api, ${unlinkedTotal} unlinked)`,
    "flowchart LR",
  ];

  // group nodes by first route segment
  const groups = new Map<string, FlowNode[]>();
  for (const n of map.nodes) {
    const g = n.kind === "synthetic" ? "_shared" : n.route?.split("/").filter(Boolean)[0]?.replace(/^:.*/, "") || "_root";
    groups.set(g, [...(groups.get(g) ?? []), n]);
  }
  for (const [g, nodes] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const render = (n: FlowNode) => `    ${idOf(n.id)}${shape(n, folded.get(n.id))}`;
    if (nodes.length === 1) {
      lines.push(render(nodes[0]!).slice(2));
      continue;
    }
    lines.push(`  subgraph ${safeId("g_" + g)}["${esc(g.replace(/^_/, ""))}"]`, ...nodes.map(render), "  end");
  }

  for (const e of map.edges) {
    if (e.kind === "navigate") lines.push(`  ${idOf(e.from)} --> ${idOf(e.to)}`);
    else if (e.kind === "submit") lines.push(`  ${idOf(e.from)} ==>|"${esc(e.backing ? `${e.backing.method} ${e.backing.path}` : e.action)}"| ${idOf(e.to)}`);
  }

  const byKind = (k: FlowNode["kind"]) => map.nodes.filter((n) => n.kind === k).map((n) => idOf(n.id));
  const auth = map.nodes.filter((n) => n.requiresAuth).map((n) => idOf(n.id));
  lines.push(
    "  classDef page fill:#eef4ff,stroke:#3b6fd8,color:#111",
    "  classDef endpoint fill:#f4f4f4,stroke:#888,color:#111",
    "  classDef synthetic fill:#fff6e0,stroke:#c98a00,color:#111",
    "  classDef auth stroke-width:3px",
  );
  for (const [cls, ids] of [["page", byKind("page")], ["endpoint", byKind("endpoint")], ["synthetic", byKind("synthetic")], ["auth", auth]] as const) {
    if (ids.length) lines.push(`  class ${ids.join(",")} ${cls}`);
  }
  return lines.join("\n") + "\n";
}

function shape(n: FlowNode, f?: { api: number; unlinked: number }): string {
  const extra = [f?.api ? `${f.api} api` : "", f?.unlinked ? `${f.unlinked} unlinked` : ""].filter(Boolean).join(", ");
  const text = esc(n.label) + (n.route ? `<br/>${esc(n.route)}` : "") + (extra ? `<br/>(${extra})` : "");
  if (n.kind === "endpoint") return `(["${text}"])`;
  if (n.kind === "synthetic") return `{{"${text}"}}`;
  return `["${text}"]`;
}

function safeId(id: string): string {
  return "n_" + id.replace(/^node:/, "").replace(/[^A-Za-z0-9_]/g, "_");
}

function esc(s: string): string {
  return s.replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;").replace(/\{/g, "#123;").replace(/\}/g, "#125;");
}
