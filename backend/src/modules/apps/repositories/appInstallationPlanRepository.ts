import { randomUUID } from "node:crypto";

import { toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { AppInstallationPlan } from "../domain/installationPlan.js";
import type { AppInstallationPlanRecord } from "../domain/records.js";

export interface CreateAppInstallationPlanInput {
  readonly workspaceId: string;
  readonly releaseId: string;
  readonly checksum: string;
  readonly plan: AppInstallationPlan;
  readonly createdBy: string | null;
  readonly expiresAt: Date;
}

/**
 * Everything consumption is conditional on, in one statement.
 *
 * Applicability and consumption used to read two different clocks and check two different
 * sets of predicates, so a plan could expire, or its release be revoked, between the check
 * and the write. One captured instant and one conditional update joined on the release row
 * close both gaps: whatever this returns true for was still approvable at the moment it
 * was consumed.
 */
export interface ConsumeAppInstallationPlanInput {
  readonly workspaceId: string;
  readonly planId: string;
  readonly checksum: string;
  readonly releaseId: string;
  readonly admissionPolicyVersion: string;
  readonly manifestDigest: string;
  readonly now: Date;
}

export interface AppInstallationPlanRepositoryPort {
  create(input: CreateAppInstallationPlanInput): Promise<AppInstallationPlanRecord>;
  findById(workspaceId: string, id: string): Promise<AppInstallationPlanRecord | null>;
  /** Compare-and-set: only the first apply of a plan wins, so a retried POST cannot install twice. */
  consume(input: ConsumeAppInstallationPlanInput): Promise<boolean>;
}

const COLUMNS = [
  "id",
  "workspace_id",
  "release_id",
  "checksum",
  "plan",
  "created_by",
  "created_at",
  "expires_at",
  "consumed_at",
] as const;

interface AppInstallationPlanRow {
  id: string;
  workspace_id: string;
  release_id: string;
  checksum: string;
  plan: unknown;
  created_by: string | null;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

const mapRecord = (row: AppInstallationPlanRow): AppInstallationPlanRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  releaseId: row.release_id,
  checksum: row.checksum,
  plan: row.plan as AppInstallationPlan,
  createdBy: row.created_by,
  createdAt: new Date(row.created_at),
  expiresAt: new Date(row.expires_at),
  consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
});

export class AppInstallationPlanRepository implements AppInstallationPlanRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(input: CreateAppInstallationPlanInput): Promise<AppInstallationPlanRecord> {
    const row = await this.db
      .insertInto("app_installation_plans")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        release_id: input.releaseId,
        checksum: input.checksum,
        plan: toJsonb(input.plan),
        created_by: input.createdBy,
        expires_at: input.expiresAt,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return mapRecord(row);
  }

  async findById(workspaceId: string, id: string): Promise<AppInstallationPlanRecord | null> {
    const row = await this.db
      .selectFrom("app_installation_plans")
      .select(COLUMNS)
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  async consume(input: ConsumeAppInstallationPlanInput): Promise<boolean> {
    const row = await this.db
      .updateTable("app_installation_plans")
      .from("app_releases")
      .set({ consumed_at: input.now })
      .where("app_installation_plans.workspace_id", "=", input.workspaceId)
      .where("app_installation_plans.id", "=", input.planId)
      .where("app_installation_plans.checksum", "=", input.checksum)
      .where("app_installation_plans.consumed_at", "is", null)
      .where("app_installation_plans.expires_at", ">", input.now)
      .where("app_installation_plans.release_id", "=", input.releaseId)
      .where("app_releases.id", "=", input.releaseId)
      .where("app_releases.state", "=", "admitted")
      .where("app_releases.admission_policy_version", "=", input.admissionPolicyVersion)
      .where("app_releases.manifest_digest", "=", input.manifestDigest)
      .returning("app_installation_plans.id as id")
      .executeTakeFirst();
    return Boolean(row);
  }
}
