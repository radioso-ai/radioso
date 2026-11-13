import { randomUUID } from "node:crypto";

import { sql } from "kysely";
import type { RoutineState } from "@radioso/conversation-contract";

import { DEFAULT_ROUTINE_STATE_TTL_MS } from "../../../db/repositories/routineStateRepository.js";
import { ConversationRepository } from "../../../db/repositories/conversationRepository.js";
import { MessageRepository, type MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { PendingDecisionCreateInput } from "../../../db/repositories/pendingDecisionRepository.js";
import { ConversationOwnershipRepository } from "../../../db/repositories/conversationOwnershipRepository.js";
import { RoutineConsentRepository } from "../../../db/repositories/routineConsentRepository.js";
import type { ConversationActivityRecorder } from "../../conversationActivity/contracts/index.js";
import { toJsonb, toSanitizedJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import {
  actionIdempotencyKey,
  type AssistantTurnPersistenceReceipt,
  type AssistantTurnPersistencePort,
} from "../services/chatTurnLifecycle.js";
import type { CutReplyStore, CutReplyStoreInput } from "../services/cutReplyMessage.js";
import type { CapturedRoutineTransition } from "../services/routines/deferredRoutineStore.js";
import type { CapturedClarificationTransition } from "../services/clarification/deferredClarificationStore.js";
import type { GroundingDiagnosticSnapshot } from "../../../shared/domain/groundingDiagnostic.js";
import { withholdMessagesWithCopies, type MessageWithholdingScope } from "../../../shared/domain/messageWithholding.js";
import { matchableValueTexts, SENSITIVE_SLOT_KEYS_METADATA_KEY, sensitiveTurnMetadata } from "../../../shared/domain/sensitiveTranscript.js";
import type { RoutineConsentCommitted, RoutineConsentWritten } from "../../../shared/domain/routineConsentTurn.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { BackgroundJobQueue, BackgroundJobRequest, BackgroundJobWakePort } from "../../../shared/background-jobs/index.js";
import type { ToolImageRowWriter } from "../../toolImages/contracts/index.js";

type CompleteAssistantTurnInput = Parameters<AssistantTurnPersistencePort["completeAssistantTurn"]>[0];

/** Told, once a turn has committed, what it recorded of its routine's consents (#1544). */
interface RoutineConsentCommitObserver {
  committed(input: RoutineConsentCommitted): void;
}

/** A consent withdrawal's message withholding, bound to the turn's transaction (#1544). */
type MessageWithholdingBinding = (db: Db) => MessageWithholdingScope;

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
): Promise<readonly string[]> => {
  if (!input.actions?.length) {
    return [];
  }
  const insertedActionTypes: string[] = [];
  for (const action of input.actions) {
    const result = await sql`
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
    `.execute(db);
    if (Number(result.numAffectedRows ?? 0) > 0) {
      insertedActionTypes.push(action.type);
    }
  }
  return insertedActionTypes;
};

const saveRoutineState = async (
  db: Db,
  state: RoutineState,
  ttlMs: number,
): Promise<void> => {
  const expiresAt = state.status === "suspended" ? null : new Date(Date.now() + ttlMs).toISOString();
  await sql`
    INSERT INTO routine_states (session_id, routine_id, execution_id, started_message_id, started_execution_id, path, variables, attempts, reask_count, status, expires_at, updated_at)
    VALUES (
      ${state.sessionId},
      ${state.routineId},
      ${state.executionId ?? null},
      ${state.startedMessageId ?? null},
      ${state.startedMessageId ? state.executionId ?? null : null},
      ${sql.val(state.path)}::text[],
      ${toJsonb(state.variables)},
      ${toJsonb(state.attempts ?? {})},
      ${state.reaskCount ?? 0},
      ${state.status},
      ${expiresAt},
      now()
    )
    ON CONFLICT (session_id) DO UPDATE SET
      routine_id = EXCLUDED.routine_id,
      execution_id = EXCLUDED.execution_id,
      started_message_id = EXCLUDED.started_message_id,
      started_execution_id = EXCLUDED.started_execution_id,
      path = EXCLUDED.path,
      variables = EXCLUDED.variables,
      attempts = EXCLUDED.attempts,
      reask_count = EXCLUDED.reask_count,
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
    // A consent withdrawn while this turn ran never leaves its covered values in the state it saved
    // (#1544). Only a routine that asks consent can hold one, so no other pays for the guard.
    if (transition.asksConsent !== false) {
      await new RoutineConsentRepository(db).stripWithdrawnSlots({ conversationId: transition.state.sessionId });
    }
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
  const outcome = transition.outcome ?? "resolved";
  // Mirrors `ClarificationStateRepository.clear`: `original_query` is retained on a
  // `declined`/`expired` clear so a failed reply mapping stays debuggable and a later
  // turn can recover the question, and is nulled only on `resolved`, where the caller
  // already received it. This transactional path is the one production runs (the
  // deferred store applies transitions inside the assistant-turn transaction), so it
  // must not diverge from the repository.
  if (outcome === "resolved") {
    await sql`
      UPDATE clarification_states
         SET status = ${outcome}, original_query = NULL, updated_at = now()
       WHERE session_id = ${transition.sessionId}
    `.execute(db);
    return;
  }
  await sql`
    UPDATE clarification_states
       SET status = ${outcome}, updated_at = now()
     WHERE session_id = ${transition.sessionId}
  `.execute(db);
};

/**
 * Marks the visitor message of a turn whose routine holds a sensitive slot value (#1543), so every
 * copy of the transcript that leaves reads it as withheld, and drops a facet the extractor may have
 * stored from it before this turn committed (the extractor runs off the turn's path; its own write
 * refuses a marked message once this commits, see MessageFacetRepository.upsertFacet). The earlier
 * messages the turn read a covered value from (#1544) gain those slots on the marker they have.
 */
const markSensitiveVisitorMessages = async (db: Db, input: CompleteAssistantTurnInput): Promise<void> => {
  const marked = input.sensitiveVisitorMessage;
  if (marked) {
    await sql`
      UPDATE messages
      SET metadata_json = metadata_json || ${toJsonb(sensitiveTurnMetadata(marked.sensitiveSlotKeys))}
      WHERE id = ${marked.id}
        AND workspace_id = ${input.workspaceId}
        AND conversation_id = ${input.conversationId}
    `.execute(db);
  }
  for (const earlier of input.sensitiveEarlierMessages ?? []) {
    await sql`
      UPDATE messages
      SET metadata_json = coalesce(metadata_json, '{}'::jsonb) || jsonb_build_object(${SENSITIVE_SLOT_KEYS_METADATA_KEY}::text, (
            SELECT jsonb_agg(DISTINCT slot_key) FROM (
              SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(metadata_json -> ${SENSITIVE_SLOT_KEYS_METADATA_KEY}::text) = 'array'
                                                    THEN metadata_json -> ${SENSITIVE_SLOT_KEYS_METADATA_KEY}::text ELSE '[]'::jsonb END)
              UNION SELECT unnest(${sql.val(earlier.sensitiveSlotKeys)}::text[])
            ) AS keys(slot_key)))
      WHERE id = ${earlier.id}
        AND workspace_id = ${input.workspaceId}
        AND conversation_id = ${input.conversationId}
        AND role = 'user'
    `.execute(db);
  }
  const ids = [...(marked ? [marked.id] : []), ...(input.sensitiveEarlierMessages ?? []).map((earlier) => earlier.id)];
  if (ids.length > 0) {
    await sql`
      DELETE FROM message_facets WHERE message_id = ANY(${sql.val(ids)}::uuid[]) AND workspace_id = ${input.workspaceId}
    `.execute(db);
  }
};

/**
 * The slots of the conversation's withdrawn consents, and the values of them this turn's routine
 * state held, as text a message would state them in.
 */
const withdrawnCoverage = (
  withdrawn: ReadonlyArray<{ routineId: string; slotKeys: readonly string[] }>,
  transition: CapturedRoutineTransition | null | undefined,
): { slotKeys: string[]; valueTexts: string[] } => {
  const states = transition ? [transition.kind === "save" ? transition.state : null, transition.startedFrom ?? null] : [];
  const values = withdrawn.flatMap((record) => states.flatMap((state) =>
    state && state.routineId === record.routineId ? record.slotKeys.map((key) => state.variables[key]) : []));
  return { slotKeys: [...new Set(withdrawn.flatMap((record) => record.slotKeys))], valueTexts: matchableValueTexts(values) };
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

export class PostgresAssistantTurnPersistence implements AssistantTurnPersistencePort, CutReplyStore {
  constructor(
    private readonly db: Db,
    // Records the handoff a turn requests in the turn's own transaction.
    private readonly conversationActivity: ConversationActivityRecorder,
    private readonly routineStateTtlMs: number = DEFAULT_ROUTINE_STATE_TTL_MS,
    private readonly conversationOwnershipRepository = new ConversationOwnershipRepository(db),
    // Optional: when wired, a turn that enqueued routine actions (contact.send,
    // handoff.notify, approval.request, ...) requests an outbox drain push once the
    // turn's own transaction has committed (spec 070 push-per-action, see the
    // conversation-action outbox drain fix). Absent leaves turns unchanged — the
    // interval-loop poller and the recovery sweep still drain the row.
    private readonly actionDrainDispatcher?: BackgroundJobWakePort,
    private readonly logger?: Pick<AppLogger, "warn">,
    // Writes the background jobs a turn hands to the worker inside the turn's transaction, and
    // wakes a worker once it commits.
    private readonly backgroundJobs?: Pick<BackgroundJobQueue, "enqueueInTransaction" | "wake">,
    // Told what a committed turn recorded of its routine's consents, for logs and metrics.
    private readonly routineConsentObserver?: RoutineConsentCommitObserver,
    // Withholds what the turn wrote once a consent of its conversation was withdrawn (#1544).
    private readonly consentMessageWithholding?: MessageWithholdingBinding,
    // Records the pictures a reply's cards show from a skill's result, with the reply.
    private readonly toolImageRows?: ToolImageRowWriter,
  ) {}

  async completeAssistantTurn(input: CompleteAssistantTurnInput): Promise<AssistantTurnPersistenceReceipt> {
    let insertedBackgroundJobs = 0;
    let consentWritten: RoutineConsentWritten[] = [];
    const run = async (db: Db): Promise<AssistantTurnPersistenceReceipt> => {
      const insertedActionTypes = await enqueueActions(db, input);
      insertedBackgroundJobs = await this.enqueueBackgroundJobs(db, input);
      await applyRoutineStateTransition(db, input.routineStateTransition, this.routineStateTtlMs);
      if (input.pendingDecisionTransition) {
        await savePendingDecision(db, input.pendingDecisionTransition);
      }
      const ownershipResult = input.ownershipHandoff
        ? await this.conversationOwnershipRepository.requestHandoff(
          {
            conversationId: input.conversationId,
            workspaceId: input.workspaceId,
            reason: input.ownershipHandoff.reason,
          },
          db,
        )
        : null;
      await applyClarificationTransition(db, input.clarificationTransition);
      await markSensitiveVisitorMessages(db, input);

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
      if (input.toolImages?.length && this.toolImageRows) {
        const captures = await this.toolImageRows.record(db, {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          messageId,
          sources: input.toolImages,
        });
        insertedBackgroundJobs += await this.enqueueJobs(db, captures, input.conversationId);
      }
      if (input.routineConsent) {
        consentWritten = await new RoutineConsentRepository(db).writeTurnEvents({
          ...input.routineConsent,
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          assistantMessageId: messageId,
        });
      }
      // Recorded after the reply that announced it, so the handoff dates after that reply.
      if (input.ownershipHandoff && ownershipResult?.changed) {
        await this.conversationActivity.record(db, {
          kind: "handoff_requested",
          conversationId: input.conversationId,
          workspaceId: input.workspaceId,
          actorUserId: null,
          detail: { reason: input.ownershipHandoff.reason },
        });
      }

      if (input.answerCoverageRequestMessageId) {
        // Coverage assessment is deliberately saved before a reply is durable so a
        // retry can reuse it. This is the sole confirmation point: the exact request
        // and assistant reply now exist in the same committing transaction.
        await sql`
          UPDATE answer_coverage_assessments
          SET assistant_message_id = ${messageId}
          WHERE workspace_id = ${input.workspaceId}
            AND conversation_id = ${input.conversationId}
            AND request_message_id = ${input.answerCoverageRequestMessageId}
            AND assistant_message_id IS NULL
        `.execute(db);
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
      const stored = await this.withholdAfterWithdrawal(db, input, message);
      // Last, inside the transaction: a turn the fence refuses rolls back whole, and one it admits
      // stays latched against a newer turn while COMMIT runs.
      input.commitFence?.();

      return {
        message: mapMessage(stored),
        committedFacts: {
          insertedActionTypes,
          decisionCreated: input.pendingDecisionTransition !== undefined && input.pendingDecisionTransition !== null,
          ownershipChanged: ownershipResult?.changed ?? false,
        },
      };
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
    const queue = insertedBackgroundJobs > 0 ? this.backgroundJobs : undefined;
    const consentReport = this.consentReport(input, consentWritten);
    if (!queue && !consentReport) {
      return result;
    }
    // Whoever owns the transaction fires this after commit (the lifecycle for its own, the caller
    // for one it supplied). Never awaited by a turn: the queue swallows and counts a failed wake,
    // and the worker's sweep runs a job whose wake was lost.
    return {
      ...result,
      afterCommit: () => {
        if (queue) void queue.wake();
        consentReport?.();
      },
    };
  }

  /**
   * A consent of the conversation withdrawn while this turn ran (#1544): the withdrawal committed
   * first, so it never saw what the turn writes now. The turn's visitor message and reply are
   * withheld, with their copies, the way the withdrawal withholds its own, when they are marked
   * with a slot it covered or state a value of one the turn's routine state held. Only a turn that
   * marks a sensitive slot or saves a routine that asks consent can carry one. Its saved state
   * locks the routine state the withdrawal erases, so one of the two always sees the other. Returns
   * the reply as stored.
   */
  private async withholdAfterWithdrawal(db: Db, input: CompleteAssistantTurnInput, reply: MessageRow): Promise<MessageRow> {
    const transition = input.routineStateTransition;
    const mayCarry = input.sensitiveVisitorMessage !== undefined || (transition?.kind === "save" && transition.asksConsent !== false);
    if (!this.consentMessageWithholding || !mayCarry) {
      return reply;
    }
    const withdrawn = await new RoutineConsentRepository(db).withdrawnInConversation({ conversationId: input.conversationId });
    const latest = withdrawn.at(-1);
    if (!latest) {
      return reply;
    }
    const { messageIds } = await withholdMessagesWithCopies(this.consentMessageWithholding(db), {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      ...withdrawnCoverage(withdrawn, transition),
      at: latest.withdrawnAt,
      among: [reply.id, ...(input.visitorMessageId ? [input.visitorMessageId] : [])],
    });
    if (!messageIds.includes(reply.id)) {
      return reply;
    }
    const reread = await sql<MessageRow>`
      SELECT id, conversation_id, workspace_id, role, content, metadata_json,
        skill_name, skill_outcome, skill_status, total_latency_ms,
        grounding_verdict, grounding_claim_count, grounding_sourced_claim_count,
        grounding_unsourced_claim_count, grounding_invalid_source_count, created_at
      FROM messages WHERE id = ${reply.id}
    `.execute(db);
    return reread.rows[0] ?? reply;
  }

  /** Reports the turn's consent events once committed; a report that fails never fails the turn. */
  private consentReport(input: CompleteAssistantTurnInput, written: readonly RoutineConsentWritten[]): (() => void) | null {
    const observer = this.routineConsentObserver;
    const consent = input.routineConsent;
    if (!observer || !consent || written.length === 0) {
      return null;
    }
    const committed: RoutineConsentCommitted = {
      workspaceId: input.workspaceId,
      agentId: consent.agentId,
      conversationId: input.conversationId,
      channel: consent.channel,
      written,
    };
    return () => {
      try {
        observer.committed(committed);
      } catch (error) {
        this.logger?.warn({ err: error, conversationId: input.conversationId }, "Routine consent report failed after the turn committed");
      }
    };
  }

  private async enqueueBackgroundJobs(db: Db, input: CompleteAssistantTurnInput): Promise<number> {
    return this.enqueueJobs(db, input.backgroundJobs ?? [], input.conversationId);
  }

  private async enqueueJobs(db: Db, jobs: readonly BackgroundJobRequest[], conversationId: string): Promise<number> {
    if (jobs.length === 0) {
      return 0;
    }
    if (!this.backgroundJobs) {
      this.logger?.warn(
        { conversationId, kinds: jobs.map((job) => job.kind) },
        "Turn requested background jobs but no background job queue is wired; skipped",
      );
      return 0;
    }
    let inserted = 0;
    for (const job of jobs) {
      const receipt = await this.backgroundJobs.enqueueInTransaction(db, job);
      if (receipt.inserted) {
        inserted += 1;
      }
    }
    return inserted;
  }

  async discardReplacedUserMessage(input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    auditEvent: CompleteAssistantTurnInput["auditEvent"];
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const deleted = await new MessageRepository(trx).deleteUserMessage({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        messageId: input.messageId,
      });
      if (deleted) {
        await insertAuditEvent(trx, input.auditEvent);
      }
      return deleted;
    });
  }

  async storeCutReply(input: CutReplyStoreInput): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await new MessageRepository(trx).create(input.assistantMessage);
      await new ConversationRepository(trx).touch(input.conversationId, input.workspaceId);
      for (const auditEvent of input.auditEvents) {
        await insertAuditEvent(trx, auditEvent);
      }
    });
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
        { err: error },
        "Action outbox drain push failed; the interval poller or recovery sweep will pick this up",
      );
    }
  }
}
