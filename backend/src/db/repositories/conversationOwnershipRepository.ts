import { sql, type RawBuilder } from "kysely";

import type { Db } from "../../shared/infra/kysely/types.js";
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
};

export interface ConversationOwnershipRequestHandoffInput {
  conversationId: string;
  workspaceId: string;
  reason: ConversationOwnershipReason;
}

export interface ConversationOwnershipRequestHandoffResult {
  record: ConversationOwnershipRecord;
  changed: boolean;
}

export interface ConversationOwnershipTakeOverInput {
  conversationId: string;
  workspaceId: string;
  /** The workspace's organisation. */
  accountId: string;
  /** The teammate claiming the conversation. */
  userId: string;
  /** Their teammate label now, stored as the fallback for when the user is gone. */
  displayName: string;
  expectedVersion?: number;
}

export interface ConversationOwnershipTransferInput {
  conversationId: string;
  accountId: string;
  /** The teammate receiving the conversation. */
  userId: string;
  /** Their teammate label now, stored as the fallback for when the user is gone. */
  displayName: string;
  expectedVersion: number;
}

export interface ConversationOwnershipHandBackInput {
  conversationId: string;
  expectedVersion: number;
  /** The teammate handing it back: only its owner may, or anyone while nobody has claimed it. */
  actingUserId: string;
}

export type ConversationOwnershipMutationResult =
  | { ok: true; changed: boolean; record: ConversationOwnershipRecord }
  | { ok: false; changed: false; record: ConversationOwnershipRecord | null };

interface ConversationOwnershipRow {
  conversation_id: string;
  workspace_id: string;
  state: string;
  owner_account_id: string | null;
  owner_user_id: string | null;
  owner_display_name: string | null;
  owner_user_display_name: string | null;
  owner_user_email: string | null;
  reason: string | null;
  version: number;
  taken_over_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// The full conversation_ownership projection over an ownership row aliased `o`, plus the owning
// user's current name and email, so the handoff module can name the owner as they are now (a
// rename shows at once). Every read and every write selects through this one fragment — writes
// through `selectWritten` — so all paths map the same way.
const conversationOwnershipProjection = sql`
  o.conversation_id,
  o.workspace_id,
  o.state,
  o.owner_account_id,
  o.owner_user_id,
  o.owner_display_name,
  owner_user.display_name AS owner_user_display_name,
  owner_user.email AS owner_user_email,
  o.reason,
  o.version,
  o.taken_over_at,
  o.created_at,
  o.updated_at
`;

const ownerUserJoin = sql`LEFT JOIN users owner_user ON owner_user.id = o.owner_user_id`;

// Runs an INSERT or UPDATE and reads its written rows back through the shared projection.
const selectWritten = (write: RawBuilder<unknown>): RawBuilder<ConversationOwnershipRow> => sql<ConversationOwnershipRow>`
  WITH written AS (
    ${write}
    RETURNING *
  )
  SELECT ${conversationOwnershipProjection}
    FROM written o
    ${ownerUserJoin}
`;

const mapRecord = (row: ConversationOwnershipRow): ConversationOwnershipRecord => ({
  conversationId: row.conversation_id,
  workspaceId: row.workspace_id,
  state: row.state as ConversationOwnershipState,
  ownerAccountId: row.owner_account_id,
  ownerUserId: row.owner_user_id,
  // No profile for a row that names no user: claimed before per-user ownership, or whose owner
  // has since been deleted (the foreign key nulls owner_user_id).
  ownerProfile: row.owner_user_email === null
    ? null
    : { displayName: row.owner_user_display_name, email: row.owner_user_email },
  ownerStoredLabel: row.owner_display_name,
  reason: row.reason,
  version: row.version,
  takenOverAt: row.taken_over_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class ConversationOwnershipRepository {
  constructor(private readonly db: Db) {}

  async load(
    conversationId: string,
    db: Db = this.db,
  ): Promise<ConversationOwnershipRecord | null> {
    const result = await sql<ConversationOwnershipRow>`
      SELECT ${conversationOwnershipProjection}
        FROM conversation_ownership o
        ${ownerUserJoin}
       WHERE o.conversation_id = ${conversationId}
    `.execute(db);

    const row = result.rows[0];
    return row ? mapRecord(row) : null;
  }

  /**
   * Reads the row and locks it until the caller's transaction ends, so no transfer, hand-back or
   * claim can commit in between; call it inside a transaction. Locks only the ownership row, not the
   * joined user. Null (and nothing locked) while no teammate has ever been involved.
   */
  async loadForUpdate(
    conversationId: string,
    db: Db = this.db,
  ): Promise<ConversationOwnershipRecord | null> {
    const result = await sql<ConversationOwnershipRow>`
      SELECT ${conversationOwnershipProjection}
        FROM conversation_ownership o
        ${ownerUserJoin}
       WHERE o.conversation_id = ${conversationId}
         FOR UPDATE OF o
    `.execute(db);

    const row = result.rows[0];
    return row ? mapRecord(row) : null;
  }

  // Batch read for list surfaces: one query for a page of conversations (no N+1). Returns a
  // map keyed by conversationId; a missing key means AI-owned (the table is lazy, no row).
  async loadByConversationIds(
    conversationIds: string[],
    db: Db = this.db,
  ): Promise<Map<string, ConversationOwnershipRecord>> {
    if (conversationIds.length === 0) {
      return new Map();
    }
    const result = await sql<ConversationOwnershipRow>`
      SELECT ${conversationOwnershipProjection}
        FROM conversation_ownership o
        ${ownerUserJoin}
       WHERE o.conversation_id = ANY(${sql.val(conversationIds)}::uuid[])
    `.execute(db);
    return new Map(result.rows.map((row) => [row.conversation_id, mapRecord(row)]));
  }

  async requestHandoff(
    input: ConversationOwnershipRequestHandoffInput,
    db: Db = this.db,
  ): Promise<ConversationOwnershipRequestHandoffResult> {
    // Request human ownership when none exists yet, OR re-request it after a prior
    // hand-back left the row ai_owned (a later routine/retrieval handoff must be able
    // to re-enter human ownership). An already human_owned row is left untouched so a
    // present operator is never clobbered — the conditional upsert returns no row in
    // that case and we read back the current record.
    const result = await selectWritten(sql`
      INSERT INTO conversation_ownership (
          conversation_id,
          workspace_id,
          state,
          owner_account_id,
          owner_user_id,
          owner_display_name,
          reason,
          version,
          taken_over_at,
          updated_at
        )
        VALUES (${input.conversationId}, ${input.workspaceId}, 'human_owned', NULL, NULL, NULL, ${input.reason}, 1, NULL, now())
        ON CONFLICT (conversation_id) DO UPDATE
          SET state = 'human_owned',
              owner_account_id = NULL,
              owner_user_id = NULL,
              owner_display_name = NULL,
              reason = EXCLUDED.reason,
              taken_over_at = NULL,
              version = conversation_ownership.version + 1,
              updated_at = now()
          WHERE conversation_ownership.state = 'ai_owned'
    `).execute(db);

    const row = result.rows[0];
    if (row) {
      return { record: mapRecord(row), changed: true };
    }

    const existing = await this.load(input.conversationId, db);
    if (existing) {
      return { record: existing, changed: false };
    }

    throw new Error("conversation_ownership_request_handoff_unresolved");
  }

  async takeOver(
    input: ConversationOwnershipTakeOverInput,
    db: Db = this.db,
  ): Promise<ConversationOwnershipMutationResult> {
    const insertedResult = await selectWritten(sql`
      INSERT INTO conversation_ownership (
          conversation_id,
          workspace_id,
          state,
          owner_account_id,
          owner_user_id,
          owner_display_name,
          reason,
          version,
          taken_over_at,
          updated_at
        )
        VALUES (${input.conversationId}, ${input.workspaceId}, 'human_owned', ${input.accountId}, ${input.userId}, ${input.displayName}, 'operator_takeover', 1, now(), now())
        ON CONFLICT (conversation_id) DO NOTHING
    `).execute(db);

    const inserted = insertedResult.rows[0];
    if (inserted) {
      return { ok: true, changed: true, record: mapRecord(inserted) };
    }

    // CAS on the version only when an expected version is supplied; otherwise claim any
    // ai-owned / unclaimed row. The predicate is spliced as a trusted `sql` fragment so the
    // optional `AND version = ...` clause matches the original conditional exactly.
    const versionPredicate = input.expectedVersion === undefined
      ? sql``
      : sql`AND version = ${input.expectedVersion}`;
    // Taking over an ai_owned row is a fresh claim: stamp `operator_takeover`. Taking over an
    // already human_owned but unclaimed row (an awaiting handoff, claimed by Send or Take over
    // instead of a reply or transfer) is claiming that handoff, so its own reason — routine_handoff,
    // retrieval_miss — survives instead of being overwritten.
    const updatedResult = await selectWritten(sql`
      UPDATE conversation_ownership
          SET state = 'human_owned',
              workspace_id = ${input.workspaceId},
              owner_account_id = ${input.accountId},
              owner_user_id = ${input.userId},
              owner_display_name = ${input.displayName},
              reason = CASE WHEN state = 'human_owned' THEN reason ELSE 'operator_takeover' END,
              version = version + 1,
              taken_over_at = now(),
              updated_at = now()
        WHERE conversation_id = ${input.conversationId}
          AND (state = 'ai_owned' OR owner_user_id IS NULL)
          ${versionPredicate}
    `).execute(db);

    const updated = updatedResult.rows[0];
    if (updated) {
      return { ok: true, changed: true, record: mapRecord(updated) };
    }

    return { ok: false, changed: false, record: await this.load(input.conversationId, db) };
  }

  async transfer(
    input: ConversationOwnershipTransferInput,
    db: Db = this.db,
  ): Promise<ConversationOwnershipMutationResult> {
    // Transfer is also how a teammate takes a conversation someone else holds (takeOver refuses
    // an owned row), and how an unclaimed handoff is assigned. Handing it to its current owner
    // is an idempotent no-op.
    const result = await selectWritten(sql`
      UPDATE conversation_ownership
          SET owner_account_id = ${input.accountId},
              owner_user_id = ${input.userId},
              owner_display_name = ${input.displayName},
              -- A row that names no user is unclaimed — a handoff nobody took, or one whose owner's
              -- user was deleted, leaving their claim time behind — so this is its first claim.
              -- SET reads the row as it was before the update.
              taken_over_at = CASE WHEN owner_user_id IS NULL THEN now() ELSE taken_over_at END,
              version = version + 1,
              updated_at = now()
        WHERE conversation_id = ${input.conversationId}
          AND state = 'human_owned'
          AND version = ${input.expectedVersion}
          AND (owner_account_id IS DISTINCT FROM ${input.accountId} OR owner_user_id IS DISTINCT FROM ${input.userId})
    `).execute(db);

    const row = result.rows[0];
    if (row) {
      return { ok: true, changed: true, record: mapRecord(row) };
    }
    const existing = await this.load(input.conversationId, db);
    if (existing?.state === "human_owned" && existing.version === input.expectedVersion
      && existing.ownerAccountId === input.accountId && existing.ownerUserId === input.userId) {
      return { ok: true, changed: false, record: existing };
    }
    return { ok: false, changed: false, record: existing };
  }

  async handBack(
    input: ConversationOwnershipHandBackInput,
    db: Db = this.db,
  ): Promise<ConversationOwnershipMutationResult> {
    const result = await selectWritten(sql`
      UPDATE conversation_ownership
          SET state = 'ai_owned',
              owner_account_id = NULL,
              owner_user_id = NULL,
              owner_display_name = NULL,
              version = version + 1,
              updated_at = now()
        WHERE conversation_id = ${input.conversationId}
          AND version = ${input.expectedVersion}
          AND (owner_user_id IS NULL OR owner_user_id = ${input.actingUserId})
          AND (
            state IS DISTINCT FROM 'ai_owned'
            OR owner_account_id IS NOT NULL
            OR owner_user_id IS NOT NULL
            OR owner_display_name IS NOT NULL
          )
    `).execute(db);

    const row = result.rows[0];
    if (row) {
      return { ok: true, changed: true, record: mapRecord(row) };
    }
    const existing = await this.load(input.conversationId, db);
    if (existing?.version === input.expectedVersion && existing.state === "ai_owned"
      && existing.ownerAccountId === null && existing.ownerUserId === null && existing.ownerStoredLabel === null) {
      return { ok: true, changed: false, record: existing };
    }
    return { ok: false, changed: false, record: existing };
  }
}
