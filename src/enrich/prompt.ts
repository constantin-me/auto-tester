import type { FlowNode } from "../mindmap/schema.js";

export const SYSTEM_PROMPT = `You document the intended behavior of one page of a web app, from its source code, so that a QA agent can later check a live copy of the page against your description.

You are given the route handler, the templates it renders and the actions already linked from the page. Write:
- label: the page's name as a person would say it ("Collection dashboard", "Login"). 1-4 words, no route syntax.
- assertions: 3-8 natural-language statements of what a correct page does. Each one must be something the code visibly guarantees, and a browser can observe: what the page shows, which controls exist, what a submit does, who may see it.
- When behavior depends on a condition the code makes visible (a guard, a role, an empty collection, a feature flag, a query parameter), say the condition in the expectation ("When the user has no collection, ...").
- check: only when the evidence contains a literal to look for (a heading, a button label, a form action, a selector or id in a template). Copy it exactly. Otherwise null. Never invent selectors or text.
- severityIfBroken: 0 cosmetic, 1 minor, 2 noticeable, 3 a feature is degraded, 4 a main workflow fails, 5 page unusable or data at risk.
- slug: 2-5 lowercase words joined by hyphens, unique within your answer.
- confidence: 0..1, how sure you are you understood the page from this evidence alone.

Describe only what the evidence shows. Do not assert styling, timing, or data values that come from the database. Templates may include shared partials (navigation, header); describe those only where they matter to this page.`;

/** Deliberately omits the node's current label and assertions: they change after a run, and the cache key must not. */
export function userPrompt(node: FlowNode, evidenceText: string): string {
  const head = [
    `Page node: ${node.id}`,
    ...(node.route ? [`Route: GET ${node.route}`] : []),
    node.guards.length ? `Guards: ${node.guards.join(", ")}` : "No guards (public).",
  ];
  return `${head.join("\n")}\n\n${evidenceText}`;
}
