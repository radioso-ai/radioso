import type { RoutinePendingStep, RoutineStartOffer } from "@radioso/conversation-contract";

import type { PreparedSession } from "./chatSessionPreparer.js";

/** How an answer composed outside a routine closes when a routine is waiting on the visitor. */
export interface RoutineClosing {
  /** A parked routine's step: the answer leads back to it. */
  pendingRoutineStep?: RoutinePendingStep;
  /** An Offer-first routine this turn offered instead of starting: the answer offers to start it. */
  routineOffer?: RoutineStartOffer;
}

/**
 * A yield happens only while a routine is active and an offer only while none is, so a turn has
 * at most one of the two.
 */
export const routineClosing = (
  session: Pick<PreparedSession, "routineYield" | "routineActivationNotice">,
): RoutineClosing => ({
  ...(session.routineYield?.pendingStep ? { pendingRoutineStep: session.routineYield.pendingStep } : {}),
  ...(session.routineActivationNotice?.offer ? { routineOffer: session.routineActivationNotice.offer } : {}),
});
