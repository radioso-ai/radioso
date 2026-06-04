import type { DirectiveMatch } from "../../directives/public.js";

import type { PreparedSession } from "./chatSessionPreparer.js";

/**
 * The terminal path a turn can take after any registered routine has declined it.
 * `retrieval` covers both grounded and direct answers; the prepared session's
 * route decides which terminal skill claims the turn.
 */
export type TurnCandidate = "retrieval";

export interface TurnSelectionInput {
  session: PreparedSession;
  /** Matched Directives this turn — soft signals a strategy may use (067 slice 4). */
  directives: DirectiveMatch[];
}

/**
 * Per-agent strategy that decides whether the terminal answer path is available.
 * Resolved at composition; the loop holds the mechanism, the strategy holds the
 * policy.
 */
export interface TurnSelectionStrategy {
  select(input: TurnSelectionInput): TurnCandidate[];
}

/**
 * v1 default: allow the terminal answer path. It accepts matched Directives now
 * so the bias seam exists; directive-driven exclusion is a later slice.
 */
export class DefaultTurnSelectionStrategy implements TurnSelectionStrategy {
  select(_input: TurnSelectionInput): TurnCandidate[] {
    return ["retrieval"];
  }
}
