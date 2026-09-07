import { randomUUID } from "node:crypto";

import { toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import { AppsError } from "../domain/errors.js";
import type { AppInstallationRecord } from "../domain/records.js";
import type { AppInstallationState } from "../domain/lifecycle.js";

export interface CreateAppInstallationInput {
  readonly workspaceId: string;
  readonly appId: string;
  readonly candidateReleaseId: string;
  readonly configuration: Readonly<Record<string, unknown>>;
}

export interface AppInstallationMutation {
  readonly state?: AppInstallationState;
  readonly activeReleaseId?: string | null;
  readonly candidateReleaseId?: string | null;
  readonly configuration?: Readonly<Record<string, unknown>>;
  readonly health?: Readonly<Record<string, unknown>>;
}

export interface AppInstallationRepositoryPort {
  create(input: CreateAppInstallationInput): Promise<AppInstallationRecord>;
  findById(workspaceId: string, id: string): Promise<AppInstallationRecord | null>;
  findLiveByAppId(workspaceId: string, appId: string): Promise<AppInstallationRecord | null>;
  listByWorkspace(workspaceId: string): Promise<AppInstallationRecord[]>;
  /**
   * Optimistic: returns `null` when `expectedVersion` no longer matches, so a caller
   * that raced another operator gets a stale-plan answer rather than a lost update.
   */
  update(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    mutation: AppInstallationMutation,
  ): Promise<AppInstallationRecord | null>;
}

const COLUMNS = [
  "id",
  "workspace_id",
  "app_id",
  "active_release_id",
  "candidate_release_id",
  "state",
  "configuration",
  "version",
  "health",
  "created_at",
  "updated_at",
] as const;

interface AppInstallationRow {
  id: string;
  workspace_id: string;
  app_id: string;
  active_release_id: string | null;
  candidate_release_id: string | null;
  state: string;
  configuration: unknown;
  version: number;
  health: unknown;
  created_at: Date;
  updated_at: Date;
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

// The plan-application service checks `findLiveByAppId` before it inserts, but that read
// and this insert are not atomic: two different plans for the same App can both pass the
// check before either writes. This partial unique index (migration 167) is what actually
// serializes the race, so its violation is the one Postgres error this insert expects to
// see and translates rather than lets leak as raw SQLSTATE.
const LIVE_INSTALLATION_UNIQUE_CONSTRAINT = "idx_app_installations_workspace_app_live";

const isLiveInstallationUniqueViolation = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && candidate.constraint === LIVE_INSTALLATION_UNIQUE_CONSTRAINT;
};

const mapRecord = (row: AppInstallationRow): AppInstallationRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  appId: row.app_id,
  activeReleaseId: row.active_release_id,
  candidateReleaseId: row.candidate_release_id,
  state: row.state as AppInstallationState,
  configuration: asObject(row.configuration),
  version: Number(row.version),
  health: asObject(row.health),
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class AppInstallationRepository implements AppInstallationRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(input: CreateAppInstallationInput): Promise<AppInstallationRecord> {
    try {
      const row = await this.db
        .insertInto("app_installations")
        .values({
          id: randomUUID(),
          workspace_id: input.workspaceId,
          app_id: input.appId,
          candidate_release_id: input.candidateReleaseId,
          state: "planned",
          configuration: toJsonb(input.configuration),
          health: toJsonb({}),
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return mapRecord(row);
    } catch (error) {
      if (isLiveInstallationUniqueViolation(error)) {
        throw new AppsError("installation_conflict", "This App is already installed in this workspace.", {
          appId: input.appId,
        });
      }
      throw error;
    }
  }

  async findById(workspaceId: string, id: string): Promise<AppInstallationRecord | null> {
    const row = await this.db
      .selectFrom("app_installations")
      .select(COLUMNS)
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  async findLiveByAppId(workspaceId: string, appId: string): Promise<AppInstallationRecord | null> {
    const row = await this.db
      .selectFrom("app_installations")
      .select(COLUMNS)
      .where("workspace_id", "=", workspaceId)
      .where("app_id", "=", appId)
      .where("state", "!=", "removed")
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<AppInstallationRecord[]> {
    const rows = await this.db
      .selectFrom("app_installations")
      .select(COLUMNS)
      .where("workspace_id", "=", workspaceId)
      .where("state", "!=", "removed")
      .orderBy("app_id")
      .execute();
    return rows.map((row) => mapRecord(row as AppInstallationRow));
  }

  async update(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    mutation: AppInstallationMutation,
  ): Promise<AppInstallationRecord | null> {
    const row = await this.db
      .updateTable("app_installations")
      .set({
        ...(mutation.state === undefined ? {} : { state: mutation.state }),
        ...(mutation.activeReleaseId === undefined ? {} : { active_release_id: mutation.activeReleaseId }),
        ...(mutation.candidateReleaseId === undefined ? {} : { candidate_release_id: mutation.candidateReleaseId }),
        ...(mutation.configuration === undefined ? {} : { configuration: toJsonb(mutation.configuration) }),
        ...(mutation.health === undefined ? {} : { health: toJsonb(mutation.health) }),
        version: expectedVersion + 1,
        updated_at: new Date(),
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .where("version", "=", expectedVersion)
      .returning(COLUMNS)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }
}
