import { choice, noul, score, type JsonValue } from "@typesafe-ai/sdk";
import type { FlowEdge, FlowNode } from "../mindmap/schema.js";
import type { Judge } from "./client.js";
import { DEFAULT_POLICY, type Policy } from "./policy.js";

/**
 * The typed judgment surface (plan Q13). Each function:
 *   - builds only the state its questions need (named JSON fields)
 *   - asks atomic questions in ONE parallel request
 *   - returns raw probabilities alongside the policy decision, so policy can be
 *     re-tuned later without re-asking
 * Jev judges; code decides.
 */

// ---- shared state shapes ---------------------------------------------------

export interface ChangedFile {
  path: string;
  /** unified diff for this file; truncated before sending */
  patch: string;
}
export interface ChangeContext {
  /** commit subject/body or PR description */
  summary: string;
  files: ChangedFile[];
}
export interface FlowContext {
  node: FlowNode;
  /** edges leaving this node: what the user can do from here */
  edges: FlowEdge[];
  /** template files this flow renders: its view, then every partial it includes */
  templates?: string[];
}

const MAX_PATCH_CHARS = 4000;
const MAX_FOCUS_CHARS = 8000;

/** Why the detector picked a flow, and the hunks that justify it. */
export interface Focus {
  reasons: string[];
  hunks: string[];
}

function changeState(change: ChangeContext, focus?: Focus): { [key: string]: JsonValue } {
  if (focus) {
    let budget = MAX_FOCUS_CHARS;
    const hunks: string[] = [];
    for (const h of focus.hunks) {
      if (budget <= 0) break;
      hunks.push(h.length > budget ? h.slice(0, budget) + "\n…(truncated)" : h);
      budget -= h.length;
    }
    return {
      summary: change.summary,
      why_this_flow: focus.reasons,
      relevant_hunks: hunks,
      all_changed_files: change.files.map((f) => f.path),
    };
  }
  return {
    summary: change.summary,
    files: change.files.map((f) => ({
      path: f.path,
      patch: f.patch.length > MAX_PATCH_CHARS ? f.patch.slice(0, MAX_PATCH_CHARS) + "\n…(truncated)" : f.patch,
    })),
  };
}

function flowState({ node, edges, templates }: FlowContext) {
  return {
    name: node.label,
    route: node.route ?? null,
    kind: node.kind,
    views: node.views.length ? node.views : node.view ? [node.view] : [],
    // without this Jev cannot see that a page renders a changed partial
    templates: templates ?? [],
    requires_auth: node.requiresAuth,
    guards: node.guards,
    source_files: node.provenance.sourceFiles,
    user_actions: edges.map((e) => `${e.kind}: ${e.action}`),
  };
}

/** Exact state a triage request sends: also the evaluation cache key, with the questions. */
export function triageState(change: ChangeContext, flow: FlowContext, focus?: Focus): { [key: string]: JsonValue } {
  return { change: changeState(change, focus), flow: flowState(flow) };
}

const inBand = (p: number, [lo, hi]: [number, number]) => p >= lo && p <= hi;

// ---- 1. triage: is this flow affected, and how valuable is testing it ------

export interface Triage {
  affected: boolean;
  /** P(changed code runs while serving this flow) */
  pRuns: number;
  /** P(change alters what the user sees or can do here) */
  pAlters: number;
  /** P(the linked change is a pure refactor) */
  pPreserving: number;
  /** 0 none … 3 breaking risk */
  impact: number;
  impactConfidence: number;
  /** 0 rarely used … 3 critical path */
  criticality: number;
  /** 0..1, for best-first scheduling (M3) */
  value: number;
  /** judgment too uncertain to trust: route to a bigger model or a human */
  escalate: boolean;
}

/** Raw Jev answers for one flow: what gets cached, so policy can be re-applied for free. */
export interface TriageRaw {
  pRuns: number;
  pAlters: number;
  pPreserving: number;
  impact: number;
  impactConfidence: number;
  criticality: number;
}

/**
 * The triage question set. Exported so evaluation caches can key raw answers by
 * its hash: editing a question invalidates cached answers instead of silently
 * mixing old and new wordings.
 */
export const TRIAGE_QUESTIONS = {
  runs_changed_code: noul(
    {
      question: "Would a user going through `flow` execute code that `change` modifies?",
      notes: [
        "`flow.source_files` are the route handler files known to serve this flow; `flow.templates` are the template files it renders (its view, then every partial that view includes).",
        "A changed shared helper, middleware or partial counts when this flow's handlers or template use it.",
        "When present, `change.why_this_flow` says how static analysis linked the change to this flow and `change.relevant_hunks` holds the linked diff hunks; check them rather than trusting them.",
      ],
    },
    {
      true: "Code changed in `change.files` runs while this flow is served or rendered.",
      false: "None of the changed code runs for this flow; it only affects other pages or is not executed.",
    },
  ),
  alters_user_behavior: noul("Would `change` alter what a user sees or can do in `flow`?", {
    true: "Visible output, navigation, validation, permissions, status codes, or the data shown or saved in this flow changes.",
    false: "Only internals, logging, comments, formatting, or other flows are affected.",
  }),
  impact: score("How strongly could `change` affect the behavior of `flow`?", [
    "No effect on this flow.",
    "Cosmetic: text, styling or layout in this flow changes, behavior stays the same.",
    "Behavior: a step, validation, redirect, permission check, or saved/shown data in this flow changes.",
    "Breaking risk: this flow could fail to load, throw an error, deny valid users, or lose data.",
  ]),
  behavior_preserving: noul(
    {
      question: "Do the code changes shown in `change` only restructure code without changing what it does?",
      notes: ["Examples: extracting an expression into a named helper, renaming, moving code, adding comments or types."],
    },
    {
      true: "Same inputs still produce the same results, responses and side effects; only the code's shape changed.",
      false: "Some input now produces a different result, response, status code, query, or side effect.",
    },
  ),
  criticality: score("How important is `flow` to the people using this app?", [
    "Rarely used, admin-only maintenance or diagnostics.",
    "Secondary feature used occasionally.",
    "Core feature used routinely.",
    "Critical path: signing in, or creating, saving or losing the user's data.",
  ]),
} as const;

export async function askTriage(judge: Judge, change: ChangeContext, flow: FlowContext, focus?: Focus): Promise<TriageRaw> {
  const a = await judge.ask("triage", triageState(change, flow, focus), TRIAGE_QUESTIONS);
  return {
    pRuns: a.runs_changed_code.noul,
    pAlters: a.alters_user_behavior.noul,
    pPreserving: a.behavior_preserving.noul,
    impact: a.impact.score,
    impactConfidence: a.impact.confidence,
    criticality: a.criticality.score,
  };
}

/** Policy over raw answers. Pure: re-run it with other thresholds at no token cost. */
export function decideTriage(raw: TriageRaw, policy: Policy = DEFAULT_POLICY): Triage {
  const p = policy.affected;
  const affected = raw.pRuns >= p.runs && (raw.pAlters >= p.alters || raw.impact >= p.minImpact) && raw.pPreserving < p.refactor;
  // a likely refactor still gets tested, just later: it scales value down instead of excluding
  const value =
    (policy.value.impactWeight * (raw.impact / 3) + policy.value.criticalityWeight * (raw.criticality / 3)) * (1 - raw.pPreserving);
  return {
    ...raw,
    affected,
    value,
    escalate: inBand(raw.pRuns, p.uncertainBand) || raw.impactConfidence < p.minImpactConfidence,
  };
}

export async function triageFlow(
  judge: Judge,
  change: ChangeContext,
  flow: FlowContext,
  policy: Policy = DEFAULT_POLICY,
  focus?: Focus,
): Promise<Triage> {
  return decideTriage(await askTriage(judge, change, flow, focus), policy);
}

// ---- 2. observation vs expectation (comparator core) -----------------------

export interface Observation {
  url: string;
  title?: string;
  status?: number;
  /** visible page text, trimmed */
  text: string;
  consoleErrors?: string[];
  failedRequests?: string[];
}

export type Verdict = "match" | "deviation" | "inconclusive";

export interface ObservationJudgment {
  verdict: Verdict;
  pSufficient: number;
  pHolds: number;
}

const MAX_TEXT_CHARS = 6000;

export async function judgeObservation(
  judge: Judge,
  expectation: string,
  observation: Observation,
  policy: Policy = DEFAULT_POLICY,
): Promise<ObservationJudgment> {
  const a = await judge.ask(
    "observation",
    {
      expectation,
      observation: { ...observation, text: observation.text.slice(0, MAX_TEXT_CHARS) },
    },
    {
      evidence_sufficient: noul("Does `observation` contain enough information to tell whether `expectation` holds?", {
        true: "The page state in `observation` directly shows the thing `expectation` is about.",
        false: "`observation` does not show the relevant part of the page, or the page did not load far enough to tell.",
      }),
      expectation_holds: noul("Does `observation` show that `expectation` holds?", {
        true: "What the page shows agrees with `expectation`.",
        false: "What the page shows contradicts `expectation`, or the expected element, text or outcome is missing.",
      }),
    },
  );
  const p = policy.observation;
  const pSufficient = a.evidence_sufficient.noul;
  const pHolds = a.expectation_holds.noul;
  const verdict: Verdict =
    pSufficient < p.sufficient ? "inconclusive" : pHolds >= p.holds ? "match" : pHolds <= p.violated ? "deviation" : "inconclusive";
  return { verdict, pSufficient, pHolds };
}

// ---- 3. severity 0–5 (user's QA rubric) ------------------------------------

// a type alias (not an interface) so it is assignable to the SDK's JSON state type
export type Finding = {
  flow: string;
  expectation: string;
  actual: string;
};

export interface Severity {
  /** expected level, may fall between rubric levels */
  score: number;
  level: 0 | 1 | 2 | 3 | 4 | 5;
  confidence: number;
}

export async function rateSeverity(judge: Judge, finding: Finding): Promise<Severity> {
  const a = await judge.ask("severity", { finding }, {
    severity: score("How severe is `finding` for releasing this version of the app?", [
      "Non-blocking and minor: a cosmetic blemish most users would not notice.",
      "Minor: a noticeable cosmetic or wording problem; the flow still fully works.",
      "Moderate: a secondary part of the flow misbehaves, and an easy workaround exists.",
      "Major: a main step of the flow fails or gives a wrong result for some users.",
      "Critical: the flow fails for most users, or data is shown or saved incorrectly.",
      "Release blocker: the app or a core flow is unusable, or user data is lost or exposed.",
    ]),
  });
  const s = a.severity.score;
  return { score: s, level: Math.min(5, Math.max(0, Math.round(s))) as Severity["level"], confidence: a.severity.confidence };
}

// ---- 4. next browser action: select among code-enumerated candidates -------

export interface CandidateAction {
  /** stable id the driver maps back to an element */
  id: string;
  /** e.g. "click link 'Collection' -> /collection" */
  description: string;
}

export interface NextAction {
  /** null when no candidate advances the goal */
  actionId: string | null;
  confidence: number;
  pGoalReached: number;
  escalate: boolean;
}

export async function chooseNextAction(
  judge: Judge,
  goal: string,
  page: Observation,
  candidates: CandidateAction[],
  policy: Policy = DEFAULT_POLICY,
): Promise<NextAction> {
  const NONE = "none_of_these";
  const criteria: Record<string, string> = Object.fromEntries(candidates.map((c) => [c.id, c.description]));
  criteria[NONE] = "No listed action moves toward `goal` from this page.";

  const a = await judge.ask(
    "next-action",
    { goal, page: { ...page, text: page.text.slice(0, MAX_TEXT_CHARS) } },
    {
      next_action: choice("Which action on `page` best moves a user toward `goal`?", criteria),
      goal_reached: noul("Does `page` already show that `goal` has been achieved?"),
    },
  );
  const picked = a.next_action.choice;
  return {
    actionId: picked === NONE ? null : picked,
    confidence: a.next_action.confidence,
    pGoalReached: a.goal_reached.noul,
    escalate: a.next_action.confidence < policy.nextAction.minConfidence,
  };
}

// ---- 5. model tier for an agent task ---------------------------------------

export type ModelTier = "cheap" | "expensive";

export async function pickModelTier(judge: Judge, task: string, policy: Policy = DEFAULT_POLICY): Promise<{ tier: ModelTier; confidence: number }> {
  const a = await judge.ask("model-tier", { task }, {
    tier: choice("What kind of model does `task` need?", {
      cheap: "Routine: follow a known flow, check a clear expectation, extract or summarize.",
      expensive: "Deep reasoning: ambiguous evidence, multi-step diagnosis, conflicting signals, or writing new expectations.",
    }),
  });
  // asymmetric on purpose: quality beats cost, so cheap must be a confident call
  const tier: ModelTier = a.tier.choice === "cheap" && a.tier.confidence >= policy.modelTier.cheapMinConfidence ? "cheap" : "expensive";
  return { tier, confidence: a.tier.confidence };
}
