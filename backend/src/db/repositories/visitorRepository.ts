import { randomUUID } from "node:crypto";

import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export interface VisitorRecord {
  id: string;
  workspaceId: string;
  visitorKey: string | null;
  verifiedCustomerId: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  conversationCount: number;
  lastCountry: string | null;
  lastLanguage: string | null;
  lastUserAgent: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Observed request facts a resolved turn contributes to a visitor's `last_*` columns. */
export interface VisitorObservedFacts {
  country: string | null;
  language: string | null;
  userAgent: string | null;
}

export interface InsertOrGetVisitorInput {
  workspaceId: string;
  visitorKey?: string | null;
  verifiedCustomerId?: string | null;
  observed: VisitorObservedFacts;
  /**
   * Seed value for `conversation_count`. Defaults to 1: the ordinary case is this
   * call itself resolving the row's first conversation. `VisitorResolver.attachVerifiedIdentity`'s
   * `moved_new` branch passes 0 — that insert never attaches a conversation by
   * itself, the {@link VisitorRepositoryPort.moveConversation} call right after it
   * does, and `moveConversation` always adds exactly one. Seeding 1 there too would
   * double-count the single conversation actually being moved.
   */
  conversationCount?: number;
}

export interface MoveConversationBetweenVisitorsInput {
  conversationId: string;
  workspaceId: string;
  /** The visitor row the conversation is leaving; null when it had none yet. */
  fromVisitorId: string | null;
  toVisitorId: string;
  /**
   * The moving conversation's own request-derived facts (spec 1277, FR-007). The
   * destination row may never have seen this browsing session before — a brand-new
   * insert has none, and an existing verified row's `last_*` reflect a previous,
   * different session — so the move carries them across rather than leaving stale
   * or empty values on a row an operator is about to look at.
   */
  observed: VisitorObservedFacts;
}

/**
 * Persistence port for the `visitors` table. Every operation is a narrow, named
 * primitive; the identity-resolution rules (verified beats anonymous, upgrade vs.
 * move, never re-attach) live in {@link VisitorResolver}, not here.
 */
export interface VisitorRepositoryPort {
  findByVerifiedCustomerId(workspaceId: string, verifiedCustomerId: string): Promise<VisitorRecord | null>;
  findByVisitorKey(workspaceId: string, visitorKey: string): Promise<VisitorRecord | null>;
  /** Workspace-scoped lookup by primary key, for the operator-facing visitor profile (spec 1277, FR-040/041). */
  findById(workspaceId: string, visitorId: string): Promise<VisitorRecord | null>;
  /**
   * Inserts a new visitor row keyed by whichever of `visitorKey` /
   * `verifiedCustomerId` is present (both, when both are fresh), or returns the
   * row an ON CONFLICT DO NOTHING lost to, re-selected. `inserted: false` tells
   * the caller the returned row's counters were not seeded by this call, so a
   * fresh conversation still needs {@link recordObservation}.
   */
  insertOrGet(input: InsertOrGetVisitorInput): Promise<{ record: VisitorRecord; inserted: boolean }>;
  /** Bumps `conversation_count` by one and refreshes `last_seen_at` / `last_*`. */
  recordObservation(visitorId: string, observed: VisitorObservedFacts): Promise<void>;
  /** Enriches an anonymous-only row with a verified id in place (User Story 2 scenario 1). */
  upgradeToVerified(visitorId: string, verifiedCustomerId: string): Promise<void>;
  /**
   * Atomically re-points one conversation at another visitor row: decrements
   * `fromVisitorId`'s count (when present), increments `toVisitorId`'s count,
   * and refreshes `toVisitorId.last_seen_at` and `last_*` with the moving
   * conversation's own observed facts (FR-007).
   */
  moveConversation(input: MoveConversationBetweenVisitorsInput): Promise<void>;
}

interface VisitorRow {
  id: string;
  workspace_id: string;
  visitor_key: string | null;
  verified_customer_id: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  conversation_count: number;
  last_country: string | null;
  last_language: string | null;
  last_user_agent: string | null;
  created_at: Date;
  updated_at: Date;
}

const visitorColumns = [
  "id",
  "workspace_id",
  "visitor_key",
  "verified_customer_id",
  "first_seen_at",
  "last_seen_at",
  "conversation_count",
  "last_country",
  "last_language",
  "last_user_agent",
  "created_at",
  "updated_at",
] as const;

const mapVisitor = (row: VisitorRow): VisitorRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  visitorKey: row.visitor_key,
  verifiedCustomerId: row.verified_customer_id,
  firstSeenAt: new Date(row.first_seen_at),
  lastSeenAt: new Date(row.last_seen_at),
  conversationCount: Number(row.conversation_count),
  lastCountry: row.last_country,
  lastLanguage: row.last_language,
  lastUserAgent: row.last_user_agent,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class VisitorRepository implements VisitorRepositoryPort {
  constructor(private readonly db: Db) {}

  async findByVerifiedCustomerId(workspaceId: string, verifiedCustomerId: string): Promise<VisitorRecord | null> {
    const row = await this.db
      .selectFrom("visitors")
      .select(visitorColumns)
      .where("workspace_id", "=", workspaceId)
      .where("verified_customer_id", "=", verifiedCustomerId)
      .executeTakeFirst();
    return row ? mapVisitor(row) : null;
  }

  async findByVisitorKey(workspaceId: string, visitorKey: string): Promise<VisitorRecord | null> {
    const row = await this.db
      .selectFrom("visitors")
      .select(visitorColumns)
      .where("workspace_id", "=", workspaceId)
      .where("visitor_key", "=", visitorKey)
      .executeTakeFirst();
    return row ? mapVisitor(row) : null;
  }

  async findById(workspaceId: string, visitorId: string): Promise<VisitorRecord | null> {
    const row = await this.db
      .selectFrom("visitors")
      .select(visitorColumns)
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", visitorId)
      .executeTakeFirst();
    return row ? mapVisitor(row) : null;
  }

  async insertOrGet(input: InsertOrGetVisitorInput): Promise<{ record: VisitorRecord; inserted: boolean }> {
    // The conflict target must name one partial unique index (Postgres allows only
    // one per ON CONFLICT clause). A visitor key is the primary key when present —
    // it is the concurrency case a brand-new conversation actually races on
    // (User Story 2 scenario 4); a verified-only insert conflicts on the other index.
    const conflictColumn = input.visitorKey ? "visitor_key" as const : "verified_customer_id" as const;
    const conflictValue = input.visitorKey ?? input.verifiedCustomerId;
    if (!conflictValue) {
      throw new Error("visitor_insert_requires_visitor_key_or_verified_key");
    }

    const now = currentTimestamp();
    const inserted = await this.db
      .insertInto("visitors")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        visitor_key: input.visitorKey ?? null,
        verified_customer_id: input.verifiedCustomerId ?? null,
        first_seen_at: now,
        last_seen_at: now,
        conversation_count: input.conversationCount ?? 1,
        last_country: input.observed.country ?? null,
        last_language: input.observed.language ?? null,
        last_user_agent: input.observed.userAgent ?? null,
      })
      .onConflict((oc) =>
        oc.columns(["workspace_id", conflictColumn]).where(conflictColumn, "is not", null).doNothing(),
      )
      .returning(visitorColumns)
      .executeTakeFirst();
    if (inserted) {
      return { record: mapVisitor(inserted), inserted: true };
    }

    const existing = await this.db
      .selectFrom("visitors")
      .select(visitorColumns)
      .where("workspace_id", "=", input.workspaceId)
      .where(conflictColumn, "=", conflictValue)
      .executeTakeFirst();
    if (!existing) {
      // The conflicting row cannot disappear between the two statements: nothing
      // in this module deletes a visitor row directly (FR-006 leaves that to a
      // future conversation-delete path). Surfacing this loudly beats a silent null.
      throw new Error("visitor_insert_conflict_reselect_miss");
    }
    return { record: mapVisitor(existing), inserted: false };
  }

  async recordObservation(visitorId: string, observed: VisitorObservedFacts): Promise<void> {
    await this.db
      .updateTable("visitors")
      .set((eb) => ({
        conversation_count: eb("conversation_count", "+", 1),
        last_seen_at: currentTimestamp(),
        last_country: observed.country ?? null,
        last_language: observed.language ?? null,
        last_user_agent: observed.userAgent ?? null,
        updated_at: currentTimestamp(),
      }))
      .where("id", "=", visitorId)
      .execute();
  }

  async upgradeToVerified(visitorId: string, verifiedCustomerId: string): Promise<void> {
    await this.db
      .updateTable("visitors")
      .set({
        verified_customer_id: verifiedCustomerId,
        last_seen_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("id", "=", visitorId)
      .execute();
  }

  async moveConversation(input: MoveConversationBetweenVisitorsInput): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      if (input.fromVisitorId) {
        await trx
          .updateTable("visitors")
          .set((eb) => ({
            conversation_count: eb("conversation_count", "-", 1),
            updated_at: currentTimestamp(),
          }))
          .where("id", "=", input.fromVisitorId)
          .execute();
      }
      await trx
        .updateTable("visitors")
        .set((eb) => ({
          conversation_count: eb("conversation_count", "+", 1),
          last_seen_at: currentTimestamp(),
          last_country: input.observed.country ?? null,
          last_language: input.observed.language ?? null,
          last_user_agent: input.observed.userAgent ?? null,
          updated_at: currentTimestamp(),
        }))
        .where("id", "=", input.toVisitorId)
        .execute();
      await trx
        .updateTable("conversations")
        .set({ visitor_id: input.toVisitorId })
        .where("id", "=", input.conversationId)
        .where("workspace_id", "=", input.workspaceId)
        .execute();
    });
  }
}
