/**
 * Decision policy over raw Jev answers. Kept apart from the questions so
 * thresholds and weights can change without re-asking anything.
 *
 * These numbers are STARTING GUESSES, not calibrated values. TypeSafe's guidance
 * is to set thresholds on your own data and consequences; tune these once runs
 * against real diffs produce labelled outcomes.
 */
export interface Policy {
  affected: {
    /** P(changed code runs in the flow) needed to count as affected */
    runs: number;
    /** P(user-visible behavior changes) needed, unless impact alone clears minImpact */
    alters: number;
    /** impact score (0..3) that makes a flow affected on its own when the code runs */
    minImpact: number;
    /** P(runs) in this band = uncertain -> escalate */
    uncertainBand: [number, number];
    /** impact confidence below this -> escalate */
    minImpactConfidence: number;
    /** P(pure refactor) at or above this -> not affected */
    refactor: number;
  };
  value: { impactWeight: number; criticalityWeight: number };
  observation: {
    /** P(evidence sufficient) below this -> inconclusive */
    sufficient: number;
    /** P(holds) at or above -> match */
    holds: number;
    /** P(holds) at or below -> deviation; between -> inconclusive */
    violated: number;
  };
  /**
   * Execution check (PER-69), pre-registered before any result: drop a candidate only when
   * every link to it is indirect (middleware, action, helper chain) AND P(the changed code
   * gives this flow's requests a different result) is below `dropBelow`. Direct handler /
   * template hits are never dropped.
   */
  execution: { dropBelow: number };
  nextAction: { minConfidence: number };
  /** cheap tier is used only when chosen with at least this confidence; quality over cost */
  modelTier: { cheapMinConfidence: number };
}

export const DEFAULT_POLICY: Policy = {
  affected: { runs: 0.5, alters: 0.4, minImpact: 2, uncertainBand: [0.35, 0.65], minImpactConfidence: 0.4, refactor: 0.7 },
  value: { impactWeight: 0.6, criticalityWeight: 0.4 },
  observation: { sufficient: 0.5, holds: 0.7, violated: 0.3 },
  // pre-registered 0.2 removed almost nothing on dev (Jev answers are moderate, never near 0);
  // re-set on dev+train only to the highest value with zero recall loss there (0.67 -> 0.83
  // precision), before batch 3 (PER-70) was prepared. Not tuned on any held-out batch.
  execution: { dropBelow: 0.45 },
  nextAction: { minConfidence: 0.5 },
  modelTier: { cheapMinConfidence: 0.6 },
};
