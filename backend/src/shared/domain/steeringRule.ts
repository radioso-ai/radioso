/**
 * A SteeringRule is the single value type for behavioral steering the answer
 * composer reads. It unifies two sources that share the same `condition → action`
 * shape but differ in origin and lifespan:
 *
 * - authored standing **Directives** (matched per turn), and
 * - skill-emitted **transient guidance** (a `SkillOutcome` injects for one turn).
 *
 * `source` and `lifespan` are assigned by the turn loop when it merges the two
 * sources into one ordered set — they are NOT authored on either side. This is
 * why `SkillTransientGuidance` is defined as `Omit<SteeringRule, "source" |
 * "lifespan">`: the executor emits the bare rule and the loop tags provenance.
 *
 * `action` is an instruction to the composer, consumed by the LLM/canned path —
 * never literal user-facing copy. Radioso is multilingual; rendering stays owned
 * by the compose path.
 */
export type SteeringSource = "directive" | "skill";

export type SteeringLifespan = "response" | "session";

export type SteeringCriticality = "low" | "medium" | "high";

export interface SteeringRule {
  action: string;
  condition?: string;
  priority?: number;
  criticality?: SteeringCriticality;
  description?: string;
  source: SteeringSource;
  lifespan: SteeringLifespan;
}

const CRITICALITY_RANK: Record<SteeringCriticality, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Orders steering rules by descending `priority`, then descending criticality.
 * Pure: returns a new array and does not mutate the input. Rules without a
 * priority sort after those with one; rules without a criticality sort lowest.
 */
export const orderSteeringRules = (rules: SteeringRule[]): SteeringRule[] =>
  [...rules].sort((a, b) => {
    const priorityDelta = (b.priority ?? 0) - (a.priority ?? 0);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return (b.criticality ? CRITICALITY_RANK[b.criticality] : 0) -
      (a.criticality ? CRITICALITY_RANK[a.criticality] : 0);
  });
