import type { RoutineActionRequest, RoutineAwaitingDecision } from "@radioso/conversation-contract";

import { buildPendingDecisionTransition } from "../../../approvals/public.js";
import { APPROVAL_REQUEST_ACTION_TYPE } from "../actions/approvalRequestActionHandler.js";
import type { PreparedSession } from "../chatSessionPreparer.js";
import type { CapturedRoutineTransition } from "./deferredRoutineStore.js";

export const buildRoutinePendingDecisionTransition = (input: {
  session: PreparedSession;
  awaitingDecision?: RoutineAwaitingDecision;
  routineStateTransition?: CapturedRoutineTransition | null;
}) => {
  if (!input.awaitingDecision) {
    return null;
  }
  if (
    input.routineStateTransition?.kind !== "save" ||
    input.routineStateTransition.state.status !== "suspended"
  ) {
    throw new Error("routine_awaiting_decision_without_suspended_state");
  }
  return buildPendingDecisionTransition({
    conversationId: input.session.conversation.id,
    sessionId: input.routineStateTransition.state.sessionId,
    workspaceId: input.session.conversation.workspaceId,
    agentId: input.session.agent.id,
    routineId: input.routineStateTransition.state.routineId,
    awaitingDecision: input.awaitingDecision,
  });
};

const buildApprovalRequestAction = (input: {
  handle: string;
  conversationId: string;
  workspaceId: string;
  agentId: string;
  routineId?: string;
  stepId?: string;
}): RoutineActionRequest => ({
  type: APPROVAL_REQUEST_ACTION_TYPE,
  payload: {
    handle: input.handle,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    routineId: input.routineId,
    stepId: input.stepId,
  },
});

/**
 * What a routine turn that parks at an approval gate adds to its commit: the pending decision
 * an operator resolves, and the `approval.request` action that tells operators about it. A live
 * turn and an approval resume that parks at the next gate add the same (#1460).
 */
export const routineAwaitingDecisionEffects = (input: {
  session: PreparedSession;
  awaitingDecision?: RoutineAwaitingDecision;
  routineStateTransition?: CapturedRoutineTransition | null;
  actions?: RoutineActionRequest[];
}): {
  pendingDecisionTransition: ReturnType<typeof buildRoutinePendingDecisionTransition>;
  actions?: RoutineActionRequest[];
} => {
  const pendingDecisionTransition = buildRoutinePendingDecisionTransition(input);
  if (!pendingDecisionTransition) {
    return { pendingDecisionTransition, ...(input.actions ? { actions: input.actions } : {}) };
  }
  return {
    pendingDecisionTransition,
    actions: [
      ...(input.actions ?? []),
      buildApprovalRequestAction({
        handle: pendingDecisionTransition.handle,
        conversationId: pendingDecisionTransition.conversationId,
        workspaceId: pendingDecisionTransition.workspaceId,
        agentId: pendingDecisionTransition.agentId,
        routineId: pendingDecisionTransition.routineId,
        stepId: pendingDecisionTransition.stepId,
      }),
    ],
  };
};
