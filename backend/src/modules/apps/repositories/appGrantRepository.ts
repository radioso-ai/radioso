import { randomUUID } from "node:crypto";

import type { Db } from "../../../shared/infra/kysely/types.js";
import type { AppGrantKind } from "../domain/installationPlan.js";
import type { AppGrantRecord } from "../domain/records.js";

export interface ApproveAppGrantsInput {
  readonly installationId: string;
  readonly releaseId: string;
  readonly planId: string | null;
  readonly approvedBy: string | null;
  readonly grants: ReadonlyArray<{ readonly kind: AppGrantKind; readonly key: string }>;
}

export interface AppGrantRepositoryPort {
  /** Idempotent: re-running the step after a crash re-approves the same set, not a duplicate. */
  approve(input: ApproveAppGrantsInput): Promise<void>;
  listLive(installationId: string): Promise<AppGrantRecord[]>;
  revokeAll(installationId: string, revokedAt: Date): Promise<number>;
}

const COLUMNS = [
  "id",
  "installation_id",
  "release_id",
  "kind",
  "key",
  "plan_id",
  "approved_by",
  "approved_at",
  "revoked_at",
] as const;

interface AppGrantRow {
  id: string;
  installation_id: string;
  release_id: string;
  kind: string;
  key: string;
  plan_id: string | null;
  approved_by: string | null;
  approved_at: Date;
  revoked_at: Date | null;
}

const mapRecord = (row: AppGrantRow): AppGrantRecord => ({
  id: row.id,
  installationId: row.installation_id,
  releaseId: row.release_id,
  kind: row.kind as AppGrantKind,
  key: row.key,
  planId: row.plan_id,
  approvedBy: row.approved_by,
  approvedAt: new Date(row.approved_at),
  revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
});

export class AppGrantRepository implements AppGrantRepositoryPort {
  constructor(private readonly db: Db) {}

  async approve(input: ApproveAppGrantsInput): Promise<void> {
    if (input.grants.length === 0) return;
    await this.db
      .insertInto("app_grants")
      .values(input.grants.map((grant) => ({
        id: randomUUID(),
        installation_id: input.installationId,
        release_id: input.releaseId,
        kind: grant.kind,
        key: grant.key,
        plan_id: input.planId,
        approved_by: input.approvedBy,
      })))
      .onConflict((conflict) => conflict.doNothing())
      .execute();
  }

  async listLive(installationId: string): Promise<AppGrantRecord[]> {
    const rows = await this.db
      .selectFrom("app_grants")
      .select(COLUMNS)
      .where("installation_id", "=", installationId)
      .where("revoked_at", "is", null)
      .orderBy("kind")
      .orderBy("key")
      .execute();
    return rows.map((row) => mapRecord(row));
  }

  async revokeAll(installationId: string, revokedAt: Date): Promise<number> {
    const rows = await this.db
      .updateTable("app_grants")
      .set({ revoked_at: revokedAt })
      .where("installation_id", "=", installationId)
      .where("revoked_at", "is", null)
      .returning("id")
      .execute();
    return rows.length;
  }
}
