import type { DirectiveMatch } from "../../directives/public.js";

import type { PreparedSession } from "./chatSessionPreparer.js";

/**
 * The kinds of path a turn can take, in the order the loop attempts them.
 * `skill_intake` runs the intake-driven skills (and yields if one matches);
 * `retrieval` is the grounded/direct answer and is terminal (always produces a
 * reply). The capability-neutral loop tries candidates in the returned order.
 */
export type TurnCandidate = "skill_intake" | "retrieval";

export interface TurnSelectionInput {
  session: PreparedSession;
  /** Matched Directives this turn — soft signals a strategy may use (067 slice 4). */
  directives: DirectiveMatch[];
}

/**
 * Per-agent strategy that decides which capability path(s) a turn attempts, in
 * order. Resolved at composition; the loop holds the mechanism, the strategy
 * holds the policy. It replaces the hard-coded "try intake, else retrieve"
 * branch in `ChatService`.
 */
export interface TurnSelectionStrategy {
  select(input: TurnSelectionInput): TurnCandidate[];
}

/**
 * v1 default: attempt skill intake first, then grounded retrieval — today's
 * behavior expressed as an ordered candidate list, so the re-seam is
 * parity-preserving. It accepts matched Directives now so the bias seam exists;
 * directive-driven reordering/exclusion is a later slice (067 slice 4).
 */
export class DefaultTurnSelectionStrategy implements TurnSelectionStrategy {
  select(_input: TurnSelectionInput): TurnCandidate[] {
    return ["skill_intake", "retrieval"];
  }
}
