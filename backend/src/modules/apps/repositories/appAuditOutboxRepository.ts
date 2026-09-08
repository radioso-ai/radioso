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
  readonly id: string;
  readonly intent: AppAuditIntent;
}

export interface AppAuditOutboxRepositoryPort {
  enqueue(intents: readonly AppAuditIntent[]): Promise<readonly string[]>;
  listUndelivered(limit: number): Promise<AppAuditOutboxRecord[]>;
  markDelivered(ids: readonly string[], deliveredAt: Date): Promise<void>;
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

  async listUndelivered(limit: number): Promise<AppAuditOutboxRecord[]> {
    const rows = await this.db
      .selectFrom("app_audit_outbox")
      .select(["id", "workspace_id", "event"])
      .where("delivered_at", "is", null)
      .orderBy("created_at")
      .limit(limit)
      .execute();
    return rows.map((row) => mapRecord(row as { id: string; workspace_id: string | null; event: unknown }));
  }

  async markDelivered(ids: readonly string[], deliveredAt: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .updateTable("app_audit_outbox")
      .set({ delivered_at: deliveredAt })
      .where("id", "in", [...ids])
      .execute();
  }
}
