import { sql } from "kysely";

import type { PendingDecisionCreateInput } from "../../../db/repositories/pendingDecisionRepository.js";
import type { WorkspaceEventRecorder } from "../../../shared/domain/workspaceEventLog.js";
import { toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import { actionIdempotencyKey, type AssistantTurnPersistencePort } from "../services/chatTurnLifecycle.js";
import { CONTACT_SEND_ACTION_TYPE } from "../services/routines/contactRoutine.js";
import { contactRequestCreatedEvent, declaredSlotValues, decisionPendingEvent, routineCompletedEvent } from "../services/workspaceEventLogDrafts.js";

type CompleteAssistantTurnInput = Parameters<AssistantTurnPersistencePort["completeAssistantTurn"]>[0];

/** A contact request a turn queued, by its outbox row. */
interface QueuedContactRequest {
  id: string;
  payload: unknown;
}

/**
 * Queues the turn's actions in the outbox, once each (a retried turn writes nothing again), and
 * reports which were new: their types, and the contact requests among them.
 */
export const enqueueActions = async (
  db: Db,
  input: CompleteAssistantTurnInput,
): Promise<{ insertedActionTypes: readonly string[]; contactRequests: readonly QueuedContactRequest[] }> => {
  const insertedActionTypes: string[] = [];
  const contactRequests: QueuedContactRequest[] = [];
  for (const action of input.actions ?? []) {
    const result = await sql<{ id: string }>`
      INSERT INTO routine_action_requests (type, payload, workspace_id, account_id, conversation_id, idempotency_key, skill_name)
      VALUES (
        ${action.type},
        ${toJsonb(action.payload ?? {})},
        ${input.workspaceId},
        ${input.accountId ?? null},
        ${input.conversationId},
        ${actionIdempotencyKey(input.conversationId, action.type, action.payload)},
        ${action.skillName ?? null}
      )
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING id
    `.execute(db);
    const inserted = result.rows[0];
    if (inserted) {
      insertedActionTypes.push(action.type);
      if (action.type === CONTACT_SEND_ACTION_TYPE) contactRequests.push({ id: inserted.id, payload: action.payload });
    }
  }
  return { insertedActionTypes, contactRequests };
};

export const savePendingDecision = async (
  db: Db,
  input: PendingDecisionCreateInput,
): Promise<void> => {
  await sql`
    INSERT INTO pending_decisions (
        handle,
        conversation_id,
        session_id,
        workspace_id,
        agent_id,
        routine_id,
        step_id,
        reason,
        options,
        decider_scope,
        content_hash,
        deadline
      )
      VALUES (
        ${input.handle},
        ${input.conversationId},
        ${input.sessionId},
        ${input.workspaceId},
        ${input.agentId},
        ${input.routineId},
        ${input.stepId},
        ${input.reason ?? null},
        ${toJsonb(input.options)},
        ${toJsonb(input.deciderScope)},
        ${input.contentHash},
        ${input.deadline ?? null}
      )
  `.execute(db);
};

/**
 * Records in the workspace event log what the turn committed that automations act on: each new
 * contact request, the decision its routine now waits on, and the routine run it ended. Handoffs
 * are recorded with their activity (`publishingWorkspaceEvents`).
 */
export const recordTurnWorkspaceEvents = async (
  db: Db,
  events: WorkspaceEventRecorder,
  input: CompleteAssistantTurnInput,
  contactRequests: readonly QueuedContactRequest[],
): Promise<void> => {
  const scope = { workspaceId: input.workspaceId, conversationId: input.conversationId };
  const transition = input.routineStateTransition;
  // The routine that ran this turn queued the actions, so its declared slots bound what they carry.
  const declaredSlotKeys = transition?.kind === "save" ? transition.declaredSlotKeys : undefined;
  for (const request of contactRequests) {
    await events.record(db, contactRequestCreatedEvent(scope, { id: request.id, values: declaredSlotValues(request.payload, declaredSlotKeys) }));
  }
  if (input.pendingDecisionTransition) {
    await events.record(db, decisionPendingEvent(input.pendingDecisionTransition));
  }
  if (transition?.kind === "save" && transition.ending) {
    await events.record(db, routineCompletedEvent(scope, transition.ending));
  }
};
