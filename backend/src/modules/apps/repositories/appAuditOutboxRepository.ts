import { randomUUID } from "node:crypto";

import { toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";

/**
 * One audit record the Apps control plane intends to emit. It is written in the same
 * transaction as the state or cursor change it describes, so a sink that is down loses
 * nothing and a crash between the commit and the delivery loses nothing either.
 */
export interface AppAuditIntent {
  /** `null` for a release-level event, which belongs to the host rather than a workspace. */
  readonly workspaceId: string | null;
  readonly accountId: string | null;
  readonly eventType: string;
  readonly eventStatus: "success" | "failure";
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AppAuditOutboxRecord {
  /** Stable across every delivery attempt, so a sink can deduplicate on it. */
  readonly id: string;
  readonly intent: AppAuditIntent;
}

export interface ClaimAppAuditOutboxInput {
  readonly limit: number;
  /** Names this dispatcher's claim. Only the token that claimed a row may acknowledge it. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

export interface AppAuditOutboxRepositoryPort {
  enqueue(intents: readonly AppAuditIntent[]): Promise<readonly string[]>;
  /**
   * Takes a bounded batch of undelivered rows for this dispatcher alone. Two request-driven
   * drains run concurrently all the time, so an unclaimed read would hand the same rows to
   * both and emit each event twice.
   */
  claimUndelivered(input: ClaimAppAuditOutboxInput): Promise<AppAuditOutboxRecord[]>;
  /** Marks delivered, but only the rows this token still holds. */
  acknowledge(ids: readonly string[], token: string, deliveredAt: Date): Promise<void>;
  /** Hands a claim back undelivered, so the next drain retries without waiting it out. */
  releaseClaim(ids: readonly string[], token: string): Promise<void>;
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

const mapRecord = (row: { id: string; workspace_id: string | null; event: unknown }): AppAuditOutboxRecord => {
  const event = asObject(row.event);
  return {
    id: row.id,
    intent: {
      workspaceId: row.workspace_id,
      accountId: typeof event.accountId === "string" ? event.accountId : null,
      eventType: asText(event.eventType),
      eventStatus: event.eventStatus === "failure" ? "failure" : "success",
      metadata: asObject(event.metadata),
    },
  };
};

export class AppAuditOutboxRepository implements AppAuditOutboxRepositoryPort {
  constructor(private readonly db: Db) {}

  async enqueue(intents: readonly AppAuditIntent[]): Promise<readonly string[]> {
    if (intents.length === 0) return [];
    const rows = await this.db
      .insertInto("app_audit_outbox")
      .values(intents.map((intent) => ({
        id: randomUUID(),
        workspace_id: intent.workspaceId,
        event: toJsonb({
          accountId: intent.accountId,
          eventType: intent.eventType,
          eventStatus: intent.eventStatus,
          metadata: intent.metadata,
        }),
      })))
      .returning("id")
      .execute();
    return rows.map((row) => row.id);
  }

  async claimUndelivered(input: ClaimAppAuditOutboxInput): Promise<AppAuditOutboxRecord[]> {
    const rows = await this.db
      .updateTable("app_audit_outbox")
      .set({ claim_token: input.token, claim_expires_at: input.expiresAt })
      .where("id", "in", (eb) => eb
        .selectFrom("app_audit_outbox")
        .select("id")
        .where("delivered_at", "is", null)
        .where((claim) => claim.or([
          claim("claim_token", "is", null),
          claim("claim_expires_at", "<=", input.now),
        ]))
        .orderBy("created_at")
        .limit(input.limit)
        // Skipping rows another dispatcher already holds is what makes two concurrent
        // drains split the backlog instead of blocking on each other.
        .forUpdate()
        .skipLocked())
      .returning(["id", "workspace_id", "event"])
      .execute();
    return rows.map((row) => mapRecord(row as { id: string; workspace_id: string | null; event: unknown }));
  }

  async acknowledge(ids: readonly string[], token: string, deliveredAt: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .updateTable("app_audit_outbox")
      .set({ delivered_at: deliveredAt, claim_token: null, claim_expires_at: null })
      .where("id", "in", [...ids])
      .where("claim_token", "=", token)
      .execute();
  }

  async releaseClaim(ids: readonly string[], token: string): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .updateTable("app_audit_outbox")
      .set({ claim_token: null, claim_expires_at: null })
      .where("id", "in", [...ids])
      .where("claim_token", "=", token)
      .where("delivered_at", "is", null)
      .execute();
  }
}
