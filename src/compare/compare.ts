import { createHash } from "node:crypto";
import { choice } from "@typesafe-ai/sdk";
import type { Assertion, FlowNode } from "../mindmap/schema.js";
import type { Judge } from "../jev/client.js";
import type { JevCache } from "../jev/cache.js";
import { MAX_TEXT_CHARS } from "../jev/judgments.js";
import { DEFAULT_POLICY, type Policy } from "../jev/policy.js";
import type { PageEvidence } from "../qa/driver.js";

/**
 * Comparator (PER-47): live behavior vs the mind-map's expectations.
 *
 * The rule that makes unreviewed model-written assertions safe to use: a finding is a
 * regression only if the assertion HELD at baseline and FAILS at head. A conditional,
 * wrong or interaction-only assertion never held on the base version, so it can never
 * become a finding. This module decides one state per assertion; the baseline/head
 * comparison and retries live in qa/check.ts.
 *
 * Code decides what code can (selector, text, url, status); only assertions with no
 * machine check go to Jev, in one batched request per page.
 */

export type AssertionState = "holds" | "fails" | "unobservable";
export type DecidedBy = "check" | "jev";
export interface AssertionEval {
  id: string;
  state: AssertionState;
  decidedBy: DecidedBy;
}
export type AssertionCache = JevCache<{ choice: string; confidence: number }[]>;

/** qa-observed assertions keep their own path in qa/check.ts; the comparator owns the rest. */
export const comparable = (node: FlowNode): Assertion[] =>
  node.assertions.filter((a) => a.provenance.origin === "llm-author" || a.provenance.origin === "human");

/** Selectors to probe in the page for these assertions (deduplicated). */
export const probeSelectors = (assertions: Assertion[]): string[] => [
  ...new Set(assertions.flatMap((a) => (a.check?.kind === "selector-visible" ? [a.check.value] : []))),
];

export const textSeen = (value: string, ev: PageEvidence) =>
  ev.observation.text.includes(value) ||
  ev.structure.headings.includes(value) ||
  ev.structure.buttons.includes(value) ||
  ev.structure.labels.includes(value);

/**
 * url-matches rule. The value is read as a path pattern (query and hash dropped, a full
 * URL reduced to its path; `*` = anything, `:name` = one segment, `^`/`$` ignored):
 *   - with a leading "/": the whole final path must match (a trailing "/" is ignored)
 *   - without one: the final path must END with it, on a segment boundary
 *     ("login" matches "/login" and "/auth/login", not "/relogin")
 */
export function urlMatches(value: string, finalPath: string): boolean {
  let v = value.trim();
  if (/^https?:\/\//.test(v)) {
    try {
      v = new URL(v).pathname;
    } catch {
      return false;
    }
  }
  v = v.replace(/[?#].*$/, "").replace(/^\^/, "").replace(/\$$/, "");
  if (!v) return false;
  const body = v
    .split(/(\*|:\w+)/)
    .map((part) => (part === "*" ? ".*" : /^:\w+$/.test(part) ? "[^/]+" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  const re = new RegExp((v.startsWith("/") ? "^" : "(?:^|/)") + body.replace(/\/$/, "") + "/?$");
  return re.test(finalPath);
}

/** Decide an assertion from its machine check alone; undefined = needs Jev. */
export function decideByCheck(a: Assertion, ev: PageEvidence): AssertionState | undefined {
  const c = a.check;
  if (!c) return undefined;
  switch (c.kind) {
    case "selector-visible": {
      const r = ev.selectors?.[c.value];
      return r === undefined || r === "invalid" ? "unobservable" : r ? "holds" : "fails";
    }
    case "text-present":
      return textSeen(c.value, ev) ? "holds" : "fails";
    case "url-matches":
      return urlMatches(c.value, ev.finalPath) ? "holds" : "fails";
    case "status-ok":
      return ev.httpStatus === undefined ? "unobservable" : ev.httpStatus < 400 ? "holds" : "fails";
    default:
      return undefined; // custom
  }
}

const JEV_CHUNK = 40;

const questionFor = (i: number) =>
  choice(
    {
      question: `Given \`page\`, is \`expectations[${i}]\` true right now?`,
      notes: ["`page` is one read-only snapshot of the loaded page: nobody clicked, typed or submitted anything."],
    },
    {
      holds: "The snapshot shows the expectation is true.",
      fails: "The snapshot shows the expectation is not true: the expected element, text or outcome is missing or contradicted, and no condition or missing interaction explains it.",
      unobservable: "Cannot be told from this snapshot: it needs interaction, depends on a condition that does not apply to this page (a setting, role or data state), or the snapshot does not show that part of the page.",
    },
  );

/** One batched request for a chunk of expectations over one page snapshot. */
async function askChunk(judge: Judge, node: FlowNode, ev: PageEvidence, chunk: Assertion[], cache?: AssertionCache) {
  const state = {
    page: {
      route: node.route ?? null,
      url: ev.finalPath,
      title: ev.structure.title,
      text: ev.observation.text.slice(0, MAX_TEXT_CHARS),
      headings: ev.structure.headings,
      buttons: ev.structure.buttons,
      labels: ev.structure.labels,
    },
    expectations: chunk.map((a) => a.expectation),
  };
  const questions = Object.fromEntries(chunk.map((_, i) => [`a${i}`, questionFor(i)]));
  const ask = async () => {
    const a = (await judge.ask("assertions", state, questions)) as Record<string, { choice: string; confidence: number }>;
    return chunk.map((_, i) => ({ choice: a[`a${i}`]!.choice, confidence: a[`a${i}`]!.confidence }));
  };
  return cache ? cache.getOrAsk(cache.key("assertions", questions, state), ask) : ask();
}

/**
 * State of each given assertion on this page. Deterministic checks first (free); the rest
 * in one Jev request per 40. A Jev answer below the policy confidence is unobservable.
 */
export async function evaluateAssertions(
  judge: Judge,
  node: FlowNode,
  assertions: Assertion[],
  ev: PageEvidence,
  cache?: AssertionCache,
  policy: Policy = DEFAULT_POLICY,
): Promise<AssertionEval[]> {
  const out = new Map<string, AssertionEval>();
  const needJev: Assertion[] = [];
  for (const a of assertions) {
    const s = decideByCheck(a, ev);
    if (s) out.set(a.id, { id: a.id, state: s, decidedBy: "check" });
    else needJev.push(a);
  }
  for (let i = 0; i < needJev.length; i += JEV_CHUNK) {
    const chunk = needJev.slice(i, i + JEV_CHUNK);
    const answers = await askChunk(judge, node, ev, chunk, cache);
    chunk.forEach((a, k) => {
      const r = answers[k]!;
      const state: AssertionState =
        r.confidence >= policy.assertion.minConfidence && (r.choice === "holds" || r.choice === "fails") ? r.choice : "unobservable";
      out.set(a.id, { id: a.id, state, decidedBy: "jev" });
    });
  }
  return assertions.map((a) => out.get(a.id)!);
}

/** Baseline states as stored on the node (id -> state). */
export const toStates = (evals: AssertionEval[]): Record<string, AssertionState> => Object.fromEntries(evals.map((e) => [e.id, e.state]));

export const countStates = (states: Record<string, AssertionState>) => {
  const n = { holds: 0, fails: 0, unobservable: 0 };
  for (const s of Object.values(states)) n[s]++;
  return n;
};

/**
 * What a check compares: assertions that held at baseline ("armed"). Those with no baseline
 * state (map enriched after the baseline) are skipped and counted, never guessed; those that
 * did not hold at baseline are not regressions by definition.
 */
export function planComparison(node: FlowNode) {
  const recorded = node.observed?.assertionStates ?? {};
  const prints = node.observed?.assertionFingerprints;
  const all = comparable(node);
  // a state counts only for the claim it was recorded for: a re-enriched assertion can come
  // back under the same id with different text, and must not inherit the old "holds"
  const stateOf = (a: Assertion) => (!prints || prints[a.id] === fingerprint(a) ? recorded[a.id] : undefined);
  return {
    /**
     * what baseline evaluated (has a state for this claim), in map order. Head evaluates this
     * same set, so Jev gets an identical question and an unchanged page replays from cache.
     */
    all: all.filter((a) => stateOf(a) !== undefined),
    armed: all.filter((a) => stateOf(a) === "holds"),
    skippedNoBaseline: all.filter((a) => stateOf(a) === undefined).length,
    notHeldAtBaseline: all.filter((a) => stateOf(a) === "fails" || stateOf(a) === "unobservable").length,
  };
}

/** Short hash of what an assertion claims (text + check), stored next to its baseline state. */
export const fingerprint = (a: Assertion): string =>
  createHash("sha256").update(JSON.stringify([a.expectation, a.check ?? null])).digest("hex").slice(0, 12);

export const toFingerprints = (assertions: Assertion[]): Record<string, string> => Object.fromEntries(assertions.map((a) => [a.id, fingerprint(a)]));

/** Armed assertions that fail at head: the regressions. */
export const regressed = (armed: Assertion[], head: AssertionEval[]): { assertion: Assertion; decidedBy: DecidedBy }[] =>
  armed.flatMap((a) => {
    const h = head.find((e) => e.id === a.id);
    return h?.state === "fails" ? [{ assertion: a, decidedBy: h.decidedBy }] : [];
  });

/** How a failed assertion reads in a report. */
export function failureText(a: Assertion, decidedBy: DecidedBy): string {
  const c = a.check;
  if (decidedBy === "jev" || !c) return "Jev read the page as not showing it";
  switch (c.kind) {
    case "selector-visible":
      return `selector ${c.value} is not visible`;
    case "text-present":
      return `"${c.value}" not found on the page`;
    case "url-matches":
      return `final path does not match ${c.value}`;
    default:
      return "status is an error (HTTP >= 400)";
  }
}
