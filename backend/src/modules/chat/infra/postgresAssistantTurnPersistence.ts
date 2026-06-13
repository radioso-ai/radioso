import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import type { RoutineState } from "@radioso/conversation-contract";

import { DEFAULT_ROUTINE_STATE_TTL_MS } from "../../../db/repositories/routineStateRepository.js";
import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { stringifyJsonb } from "../../../shared/infra/jsonb.js";
import type { Database } from "../../../shared/infra/database.js";
import {
  actionIdempotencyKey,
  type AssistantTurnPersistencePort,
} from "../services/chatTurnLifecycle.js";
import type { CapturedRoutineTransition } from "../services/routines/deferredRoutineStore.js";
import type { CapturedClarificationTransition } from "../services/clarification/deferredClarificationStore.js";

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
  createdAt: new Date(row.created_at),
});

const enqueueActions = async (
  client: PoolClient,
  input: CompleteAssistantTurnInput,
): Promise<void> => {
  if (!input.actions?.length) {
    return;
  }
  for (const action of input.actions) {
    await client.query(
      `INSERT INTO routine_action_requests (type, payload, workspace_id, account_id, conversation_id, idempotency_key)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [
        action.type,
        JSON.stringify(action.payload ?? {}),
        input.workspaceId,
        input.accountId ?? null,
        input.conversationId,
        actionIdempotencyKey(input.conversationId, action.type, action.payload),
      ],
    );
  }
};

const saveRoutineState = async (
  client: PoolClient,
  state: RoutineState,
  ttlMs: number,
): Promise<void> => {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await client.query(
    `INSERT INTO routine_states (session_id, routine_id, path, variables, attempts, status, expires_at, updated_at)
     VALUES ($1, $2, $3::text[], $4::jsonb, $5::jsonb, $6, $7, now())
     ON CONFLICT (session_id) DO UPDATE SET
       routine_id = EXCLUDED.routine_id,
       path = EXCLUDED.path,
       variables = EXCLUDED.variables,
       attempts = EXCLUDED.attempts,
       status = EXCLUDED.status,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [
      state.sessionId,
      state.routineId,
      state.path,
      JSON.stringify(state.variables),
      JSON.stringify(state.attempts ?? {}),
      state.status,
      expiresAt,
    ],
  );
};

const applyRoutineStateTransition = async (
  client: PoolClient,
  transition: CapturedRoutineTransition | null | undefined,
  ttlMs: number,
): Promise<void> => {
  if (!transition) {
    return;
  }
  if (transition.kind === "save") {
    await saveRoutineState(client, transition.state, ttlMs);
    return;
  }
  await client.query(`DELETE FROM routine_states WHERE session_id = $1`, [transition.sessionId]);
};

const saveClarificationState = async (
  client: PoolClient,
  pending: Extract<CapturedClarificationTransition, { kind: "save" }>["pending"],
): Promise<void> => {
  await client.query(
    `INSERT INTO clarification_states (session_id, source, candidates, asked_event_id, status, expires_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, now())
     ON CONFLICT (session_id) DO UPDATE SET
       source = EXCLUDED.source,
       candidates = EXCLUDED.candidates,
       asked_event_id = EXCLUDED.asked_event_id,
       status = EXCLUDED.status,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [
      pending.sessionId,
      pending.source,
      JSON.stringify(pending.candidates),
      pending.askedEventId ?? null,
      pending.status,
      new Date(pending.expiresAt).toISOString(),
    ],
  );
};

const applyClarificationTransition = async (
  client: PoolClient,
  transition: CapturedClarificationTransition | null | undefined,
): Promise<void> => {
  if (!transition) {
    return;
  }
  if (transition.kind === "save") {
    await saveClarificationState(client, transition.pending);
    return;
  }
  await client.query(
    `UPDATE clarification_states
        SET status = $2, updated_at = now()
      WHERE session_id = $1`,
    [transition.sessionId, transition.outcome ?? "resolved"],
  );
};

export class PostgresAssistantTurnPersistence implements AssistantTurnPersistencePort {
  constructor(
    private readonly database: Database,
    private readonly routineStateTtlMs: number = DEFAULT_ROUTINE_STATE_TTL_MS,
  ) {}

  async completeAssistantTurn(input: CompleteAssistantTurnInput): Promise<MessageRecord> {
    return this.database.withTransaction(async (client) => {
      await enqueueActions(client, input);
      await applyRoutineStateTransition(client, input.routineStateTransition, this.routineStateTtlMs);
      await applyClarificationTransition(client, input.clarificationTransition);

      const messageId = input.assistantMessage.id ?? randomUUID();
      const messageResult = await client.query<MessageRow>(
        `INSERT INTO messages (id, conversation_id, workspace_id, role, content, metadata_json, skill_name, skill_outcome, skill_status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, clock_timestamp())
         RETURNING id, conversation_id, workspace_id, role, content, metadata_json, skill_name, skill_outcome, skill_status, created_at`,
        [
          messageId,
          input.assistantMessage.conversationId,
          input.assistantMessage.workspaceId,
          input.assistantMessage.role,
          input.assistantMessage.content,
          stringifyJsonb(input.assistantMessage.metadata ?? input.assistantMessage.inputMetadata ?? {}),
          input.assistantMessage.skillName ?? null,
          input.assistantMessage.skillOutcome ?? null,
          input.assistantMessage.skillStatus ?? null,
        ],
      );

      await client.query(
        `UPDATE conversations SET updated_at = now() WHERE id = $1 AND workspace_id = $2`,
        [input.conversationId, input.workspaceId],
      );

      await client.query(
        `INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          randomUUID(),
          input.auditEvent.accountId ?? null,
          input.auditEvent.workspaceId ?? null,
          input.auditEvent.eventType,
          input.auditEvent.eventStatus,
          stringifyJsonb(input.auditEvent.metadata ?? {}),
        ],
      );

      return mapMessage(messageResult.rows[0]!);
    });
  }
}
