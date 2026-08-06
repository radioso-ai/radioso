import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import type { RoutineState } from "@radioso/conversation-contract";

import { DEFAULT_ROUTINE_STATE_TTL_MS } from "../../../db/repositories/routineStateRepository.js";
import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { PendingDecisionCreateInput } from "../../../db/repositories/pendingDecisionRepository.js";
import { ConversationOwnershipRepository } from "../../../db/repositories/conversationOwnershipRepository.js";
import { toJsonb, toSanitizedJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import {
  actionIdempotencyKey,
  type AssistantTurnPersistencePort,
} from "../services/chatTurnLifecycle.js";
import type { CapturedRoutineTransition } from "../services/routines/deferredRoutineStore.js";
import type { CapturedClarificationTransition } from "../services/clarification/deferredClarificationStore.js";
import type { GroundingDiagnosticSnapshot } from "../../../shared/domain/groundingDiagnostic.js";
import type { ActionDrainDispatcherPort } from "../services/actions/actionDrainDispatcher.js";
import type { AppLogger } from "../../../shared/observability/logger.js";

type CompleteAssistantTurnInput = Parameters<AssistantTurnPersistencePort["completeAssistantTurn"]>[0];

interface MessageRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata_json: unknown;
  skill_name: string | null;
  skill_outcome: string | null;
  skill_status: string | null;
  total_latency_ms: number | null;
  grounding_verdict: GroundingDiagnosticSnapshot["verdict"] | null;
  grounding_claim_count: number | null;
  grounding_sourced_claim_count: number | null;
  grounding_unsourced_claim_count: number | null;
  grounding_invalid_source_count: number | null;
  created_at: Date;
}

const mapMessage = (row: MessageRow): MessageRecord => ({
  id: row.id,
  conversationId: row.conversation_id,
  workspaceId: row.workspace_id,
  role: row.role,
  content: row.content,
  metadata: row.metadata_json && typeof row.metadata_json === "object" && !Array.isArray(row.metadata_json)
    ? row.metadata_json as Record<string, unknown>
    : undefined,
  skillName: row.skill_name ?? undefined,
  skillOutcome: row.skill_outcome ?? undefined,
  skillStatus: row.skill_status ?? undefined,
  totalLatencyMs: row.total_latency_ms ?? undefined,
  grounding: row.grounding_verdict === null
    ? undefined
    : {
        verdict: row.grounding_verdict,
        claimCount: row.grounding_claim_count!,
        sourcedClaimCount: row.grounding_sourced_claim_count!,
        unsourcedClaimCount: row.grounding_unsourced_claim_count!,
        invalidSourceCount: row.grounding_invalid_source_count!,
      },
  createdAt: new Date(row.created_at),
});

const enqueueActions = async (
  db: Db,
  input: CompleteAssistantTurnInput,
): Promise<void> => {
  if (!input.actions?.length) {
    return;
  }
  for (const action of input.actions) {
    await sql`
      INSERT INTO routine_action_requests (type, payload, workspace_id, account_id, conversation_id, idempotency_key)
      VALUES (
        ${action.type},
        ${toJsonb(action.payload ?? {})},
        ${input.workspaceId},
        ${input.accountId ?? null},
        ${input.conversationId},
        ${actionIdempotencyKey(input.conversationId, action.type, action.payload)}
      )
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `.execute(db);
  }
};

const saveRoutineState = async (
  db: Db,
  state: RoutineState,
  ttlMs: number,
): Promise<void> => {
  const expiresAt = state.status === "suspended" ? null : new Date(Date.now() + ttlMs).toISOString();
  await sql`
    INSERT INTO routine_states (session_id, routine_id, path, variables, attempts, status, expires_at, updated_at)
    VALUES (
      ${state.sessionId},
      ${state.routineId},
      ${sql.val(state.path)}::text[],
      ${toJsonb(state.variables)},
      ${toJsonb(state.attempts ?? {})},
      ${state.status},
      ${expiresAt},
      now()
    )
    ON CONFLICT (session_id) DO UPDATE SET
      routine_id = EXCLUDED.routine_id,
      path = EXCLUDED.path,
      variables = EXCLUDED.variables,
      attempts = EXCLUDED.attempts,
      status = EXCLUDED.status,
      expires_at = EXCLUDED.expires_at,
      updated_at = now()
  `.execute(db);
};

const applyRoutineStateTransition = async (
  db: Db,
  transition: CapturedRoutineTransition | null | undefined,
  ttlMs: number,
): Promise<void> => {
  if (!transition) {
    return;
  }
  if (transition.kind === "save") {
    await saveRoutineState(db, transition.state, ttlMs);
    return;
  }
  await sql`DELETE FROM routine_states WHERE session_id = ${transition.sessionId}`.execute(db);
};

const savePendingDecision = async (
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

const saveClarificationState = async (
  db: Db,
  pending: Extract<CapturedClarificationTransition, { kind: "save" }>["pending"],
): Promise<void> => {
  await sql`
    INSERT INTO clarification_states (session_id, source, original_query, mode, candidates, asked_event_id, status, expires_at, updated_at)
    VALUES (
      ${pending.sessionId},
      ${pending.source},
      ${pending.originalQuery ?? null},
      ${pending.mode ?? "ask"},
      ${toJsonb(pending.candidates)},
      ${pending.askedEventId ?? null},
      ${pending.status},
      ${new Date(pending.expiresAt).toISOString()},
      now()
    )
    ON CONFLICT (session_id) DO UPDATE SET
      source = EXCLUDED.source,
      original_query = EXCLUDED.original_query,
      mode = EXCLUDED.mode,
      candidates = EXCLUDED.candidates,
      asked_event_id = EXCLUDED.asked_event_id,
      status = EXCLUDED.status,
      expires_at = EXCLUDED.expires_at,
      updated_at = now()
  `.execute(db);
};

const applyClarificationTransition = async (
  db: Db,
  transition: CapturedClarificationTransition | null | undefined,
): Promise<void> => {
  if (!transition) {
    return;
  }
  if (transition.kind === "save") {
    await saveClarificationState(db, transition.pending);
    return;
  }
  await sql`
    UPDATE clarification_states
       SET status = ${transition.outcome ?? "resolved"}, original_query = NULL, updated_at = now()
     WHERE session_id = ${transition.sessionId}
  `.execute(db);
};

const insertAuditEvent = async (
  db: Db,
  event: CompleteAssistantTurnInput["auditEvent"],
): Promise<void> => {
  await sql`
    INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json)
    VALUES (
      ${randomUUID()},
      ${event.accountId ?? null},
      ${event.workspaceId ?? null},
      ${event.eventType},
      ${event.eventStatus},
      ${toSanitizedJsonb(event.metadata ?? {})}
    )
  `.execute(db);
};

export class PostgresAssistantTurnPersistence implements AssistantTurnPersistencePort {
  constructor(
    private readonly db: Db,
    private readonly routineStateTtlMs: number = DEFAULT_ROUTINE_STATE_TTL_MS,
    private readonly conversationOwnershipRepository = new ConversationOwnershipRepository(db),
    // Optional: when wired, a turn that enqueued routine actions (contact.send,
    // handoff.notify, approval.request, ...) requests an outbox drain push once the
    // turn's own transaction has committed (spec 070 push-per-action, see the
    // conversation-action outbox drain fix). Absent leaves turns unchanged — the
    // interval-loop poller and the recovery sweep still drain the row.
    private readonly actionDrainDispatcher?: ActionDrainDispatcherPort,
    private readonly logger?: Pick<AppLogger, "warn">,
  ) {}

  async completeAssistantTurn(input: CompleteAssistantTurnInput): Promise<MessageRecord> {
    const run = async (db: Db): Promise<MessageRecord> => {
      await enqueueActions(db, input);
      await applyRoutineStateTransition(db, input.routineStateTransition, this.routineStateTtlMs);
      if (input.pendingDecisionTransition) {
        await savePendingDecision(db, input.pendingDecisionTransition);
      }
      if (input.ownershipHandoff) {
        await this.conversationOwnershipRepository.requestHandoff(
          {
            conversationId: input.conversationId,
            workspaceId: input.workspaceId,
            reason: input.ownershipHandoff.reason,
          },
          db,
        );
      }
      await applyClarificationTransition(db, input.clarificationTransition);

      const messageId = input.assistantMessage.id ?? randomUUID();
      const result = await sql<MessageRow>`
        INSERT INTO messages (
          id, conversation_id, workspace_id, role, content, metadata_json,
          skill_name, skill_outcome, skill_status, total_latency_ms,
          grounding_verdict, grounding_claim_count, grounding_sourced_claim_count,
          grounding_unsourced_claim_count, grounding_invalid_source_count, created_at
        )
        VALUES (
          ${messageId},
          ${input.assistantMessage.conversationId},
          ${input.assistantMessage.workspaceId},
          ${input.assistantMessage.role},
          ${input.assistantMessage.content},
          ${toSanitizedJsonb(input.assistantMessage.metadata ?? input.assistantMessage.inputMetadata ?? {})},
          ${input.assistantMessage.skillName ?? null},
          ${input.assistantMessage.skillOutcome ?? null},
          ${input.assistantMessage.skillStatus ?? null},
          ${input.assistantMessage.totalLatencyMs ?? null},
          ${input.assistantMessage.grounding?.verdict ?? null},
          ${input.assistantMessage.grounding?.claimCount ?? null},
          ${input.assistantMessage.grounding?.sourcedClaimCount ?? null},
          ${input.assistantMessage.grounding?.unsourcedClaimCount ?? null},
          ${input.assistantMessage.grounding?.invalidSourceCount ?? null},
          clock_timestamp()
        )
        RETURNING id, conversation_id, workspace_id, role, content, metadata_json,
          skill_name, skill_outcome, skill_status, total_latency_ms,
          grounding_verdict, grounding_claim_count, grounding_sourced_claim_count,
          grounding_unsourced_claim_count, grounding_invalid_source_count, created_at
      `.execute(db);
      const message = result.rows[0];
      if (!message) {
        throw new Error("Expected inserted assistant message");
      }

      await sql`
        UPDATE conversations SET updated_at = now() WHERE id = ${input.conversationId} AND workspace_id = ${input.workspaceId}
      `.execute(db);

      await insertAuditEvent(db, input.auditEvent);
      if (input.ownershipAuditEvent) {
        await insertAuditEvent(db, input.ownershipAuditEvent);
      }
      if (input.additionalAuditEvent) {
        await insertAuditEvent(db, input.additionalAuditEvent);
      }

      return mapMessage(message);
    };

    // When the caller supplies an open transaction (the pending-decision commit fence),
    // run on it directly so the decision flip, routine resume, and this turn commit
    // together — that commit lands one frame up, in the fence's own `.transaction()`
    // call, after this method returns. Otherwise open a fresh transaction for the
    // whole turn, which has committed by the time `.execute()` resolves below.
    const result = input.transaction
      ? await run(input.transaction)
      : await this.db.transaction().execute(async (trx) => run(trx));

    await this.requestActionDrain(input.actions);
    return result;
  }

  /**
   * Best-effort push: never fails the turn that already committed. In the normal
   * (self-managed transaction) path this fires strictly after commit. In the rarer
   * externally-supplied-transaction path (HITL decision resume) it can fire a few
   * microseconds before that outer transaction's own commit lands — accepted, since a
   * Cloud Tasks round trip is far slower than the remaining in-process work before that
   * commit, and any residual race is covered by the recovery sweep, not silently lost.
   */
  private async requestActionDrain(actions: CompleteAssistantTurnInput["actions"]): Promise<void> {
    if (!actions?.length || !this.actionDrainDispatcher) {
      return;
    }
    try {
      await this.actionDrainDispatcher.requestDrain();
    } catch (error) {
      this.logger?.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "Action outbox drain push failed; the interval poller or recovery sweep will pick this up",
      );
    }
  }
}
