import { createHash } from "node:crypto";

import type { PendingDecisionCreateInput } from "../../../db/repositories/pendingDecisionRepository.js";
import { canonicalJson } from "../../../shared/domain/canonicalContentHash.js";
import type { WorkspaceEventDraft } from "../../../shared/domain/workspaceEvents.js";
import type { EndedRoutineRun } from "./routines/endedRoutineRun.js";

/**
 * Chat's events for the workspace event log (#1851), built from the facts a turn commits. Each names
 * the fact it records, so a second write of the same fact is dropped.
 */

interface ConversationScope {
  workspaceId: string;
  conversationId: string;
}

const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const valuesDigest = (values: Record<string, unknown>): string =>
  createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(values)) as unknown)).digest("hex").slice(0, 32);

/**
 * An ended routine run. The run and its values name the fact: a visitor's later correction to the
 * run records it again with the corrected values, and saving the same values again records nothing.
 */
export const routineCompletedEvent = (scope: ConversationScope, run: EndedRoutineRun): WorkspaceEventDraft => ({
  type: "routine.completed",
  ...scope,
  idempotencyKey: `routine.completed:${run.executionId ?? `${scope.conversationId}:${run.routineId}`}:${valuesDigest(run.values)}`,
  detail: {
    routineId: run.routineId,
    executionId: run.executionId,
    outcome: run.outcome,
    values: run.values,
    sensitiveSlotKeys: run.sensitiveSlotKeys,
  },
});

/** A contact request as it was queued: the values the visitor gave, sensitive ones already masked. */
export const contactRequestCreatedEvent = (
  scope: ConversationScope,
  request: { id: string; payload: unknown },
): WorkspaceEventDraft => ({
  type: "contact_request.created",
  ...scope,
  idempotencyKey: `contact_request.created:${request.id}`,
  detail: { contactRequestId: request.id, values: recordOf(request.payload) },
});

/**
 * A decision a routine waits on. Its reason is the text the author wrote on the step, never rendered
 * with the run's values, and its options carry only what an operator chooses between.
 */
export const decisionPendingEvent = (decision: PendingDecisionCreateInput): WorkspaceEventDraft => ({
  type: "decision.pending",
  workspaceId: decision.workspaceId,
  conversationId: decision.conversationId,
  idempotencyKey: `decision.pending:${decision.handle}`,
  detail: {
    decisionHandle: decision.handle,
    routineId: decision.routineId,
    stepId: decision.stepId,
    reason: decision.reason ?? null,
    options: decision.options.map((option) => ({ id: option.id, label: option.label })),
    deadline: decision.deadline ? decision.deadline.toISOString() : null,
  },
});
