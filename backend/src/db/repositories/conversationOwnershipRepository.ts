import {
  type Database,
  type DatabaseExecutor,
} from "../../shared/infra/database.js";
// The domain module owns the ownership record shape; this repository is its
// persistence adapter and imports the canonical types rather than redefining them
// (db/repositories importing from modules/ is the established pattern here).
import type {
  ConversationOwnershipRecord,
  ConversationOwnershipReason,
  ConversationOwnershipState,
} from "../../modules/handoff/ownershipState.js";

export type {
  ConversationOwnershipRecord,
  ConversationOwnershipReason,
  ConversationOwnershipState,
};

export interface ConversationOwnershipRequestHandoffInput {
  conversationId: string;
  workspaceId: string;
  reason: ConversationOwnershipReason;
}

export interface ConversationOwnershipTakeOverInput {
  conversationId: string;
  workspaceId: string;
  accountId: string;
  displayName: string;
  expectedVersion?: number;
}

export interface ConversationOwnershipTransferInput {
  conversationId: string;
  accountId: string;
  displayName: string;
  expectedVersion: number;
}

export interface ConversationOwnershipHandBackInput {
  conversationId: string;
  expectedVersion: number;
}

export type ConversationOwnershipMutationResult =
  | { ok: true; record: ConversationOwnershipRecord }
  | { ok: false; record: ConversationOwnershipRecord | null };

interface ConversationOwnershipRow {
  conversation_id: string;
  workspace_id: string;
  state: string;
  owner_account_id: string | null;
  owner_display_name: string | null;
  reason: string | null;
  version: number;
  taken_over_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const conversationOwnershipColumns = `
  conversation_id,
  workspace_id,
  state,
  owner_account_id,
  owner_display_name,
  reason,
  version,
  taken_over_at,
  created_at,
  updated_at
`;

const mapRecord = (row: ConversationOwnershipRow): ConversationOwnershipRecord => ({
  conversationId: row.conversation_id,
  workspaceId: row.workspace_id,
  state: row.state as ConversationOwnershipState,
  ownerAccountId: row.owner_account_id,
  ownerDisplayName: row.owner_display_name,
  reason: row.reason as ConversationOwnershipReason | null,
  version: row.version,
  takenOverAt: row.taken_over_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class ConversationOwnershipRepository {
  constructor(private readonly database: Database) {}

  async load(
    conversationId: string,
    executor: Pick<DatabaseExecutor, "queryOptional"> = this.database,
  ): Promise<ConversationOwnershipRecord | null> {
    const row = await executor.queryOptional<ConversationOwnershipRow>(
      `SELECT ${conversationOwnershipColumns}
         FROM conversation_ownership
        WHERE conversation_id = $1`,
      [conversationId],
    );

    return row ? mapRecord(row) : null;
  }

  async requestHandoff(
    input: ConversationOwnershipRequestHandoffInput,
    executor: Pick<DatabaseExecutor, "queryOptional"> = this.database,
  ): Promise<ConversationOwnershipRecord> {
    // Request human ownership when none exists yet, OR re-request it after a prior
    // hand-back left the row ai_owned (a later routine/retrieval handoff must be able
    // to re-enter human ownership). An already human_owned row is left untouched so a
    // present operator is never clobbered — the conditional upsert returns no row in
    // that case and we read back the current record.
    const row = await executor.queryOptional<ConversationOwnershipRow>(
      `INSERT INTO conversation_ownership (
          conversation_id,
          workspace_id,
          state,
          owner_account_id,
          owner_display_name,
          reason,
          version,
          taken_over_at,
          updated_at
        )
        VALUES ($1, $2, 'human_owned', NULL, NULL, $3, 1, NULL, now())
        ON CONFLICT (conversation_id) DO UPDATE
          SET state = 'human_owned',
              owner_account_id = NULL,
              owner_display_name = NULL,
              reason = EXCLUDED.reason,
              taken_over_at = NULL,
              version = conversation_ownership.version + 1,
              updated_at = now()
          WHERE conversation_ownership.state = 'ai_owned'
        RETURNING ${conversationOwnershipColumns}`,
      [input.conversationId, input.workspaceId, input.reason],
    );

    if (row) {
      return mapRecord(row);
    }

    const existing = await this.load(input.conversationId, executor);
    if (existing) {
      return existing;
    }

    throw new Error("conversation_ownership_request_handoff_unresolved");
  }

  async takeOver(
    input: ConversationOwnershipTakeOverInput,
    executor: Pick<DatabaseExecutor, "queryOptional"> = this.database,
  ): Promise<ConversationOwnershipMutationResult> {
    const inserted = await executor.queryOptional<ConversationOwnershipRow>(
      `INSERT INTO conversation_ownership (
          conversation_id,
          workspace_id,
          state,
          owner_account_id,
          owner_display_name,
          reason,
          version,
          taken_over_at,
          updated_at
        )
        VALUES ($1, $2, 'human_owned', $3, $4, 'operator_takeover', 1, now(), now())
        ON CONFLICT (conversation_id) DO NOTHING
        RETURNING ${conversationOwnershipColumns}`,
      [input.conversationId, input.workspaceId, input.accountId, input.displayName],
    );

    if (inserted) {
      return { ok: true, record: mapRecord(inserted) };
    }

    const versionPredicate = input.expectedVersion === undefined ? "" : "AND version = $5";
    const params = input.expectedVersion === undefined
      ? [input.conversationId, input.accountId, input.displayName, input.workspaceId]
      : [
          input.conversationId,
          input.accountId,
          input.displayName,
          input.workspaceId,
          input.expectedVersion,
        ];
    const updated = await executor.queryOptional<ConversationOwnershipRow>(
      `UPDATE conversation_ownership
          SET state = 'human_owned',
              workspace_id = $4,
              owner_account_id = $2,
              owner_display_name = $3,
              reason = 'operator_takeover',
              version = version + 1,
              taken_over_at = now(),
              updated_at = now()
        WHERE conversation_id = $1
          AND (state = 'ai_owned' OR owner_account_id IS NULL)
          ${versionPredicate}
        RETURNING ${conversationOwnershipColumns}`,
      params,
    );

    if (updated) {
      return { ok: true, record: mapRecord(updated) };
    }

    return { ok: false, record: await this.load(input.conversationId, executor) };
  }

  async transfer(
    input: ConversationOwnershipTransferInput,
    executor: Pick<DatabaseExecutor, "queryOptional"> = this.database,
  ): Promise<ConversationOwnershipMutationResult> {
    const row = await executor.queryOptional<ConversationOwnershipRow>(
      `UPDATE conversation_ownership
          SET owner_account_id = $2,
              owner_display_name = $3,
              version = version + 1,
              updated_at = now()
        WHERE conversation_id = $1
          AND state = 'human_owned'
          AND version = $4
        RETURNING ${conversationOwnershipColumns}`,
      [input.conversationId, input.accountId, input.displayName, input.expectedVersion],
    );

    if (row) {
      return { ok: true, record: mapRecord(row) };
    }

    return { ok: false, record: await this.load(input.conversationId, executor) };
  }

  async handBack(
    input: ConversationOwnershipHandBackInput,
    executor: Pick<DatabaseExecutor, "queryOptional"> = this.database,
  ): Promise<ConversationOwnershipMutationResult> {
    const row = await executor.queryOptional<ConversationOwnershipRow>(
      `UPDATE conversation_ownership
          SET state = 'ai_owned',
              owner_account_id = NULL,
              owner_display_name = NULL,
              version = version + 1,
              updated_at = now()
        WHERE conversation_id = $1
          AND version = $2
        RETURNING ${conversationOwnershipColumns}`,
      [input.conversationId, input.expectedVersion],
    );

    if (row) {
      return { ok: true, record: mapRecord(row) };
    }

    return { ok: false, record: await this.load(input.conversationId, executor) };
  }
}
