import { randomUUID } from "node:crypto";

import { toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import { AppsError } from "../domain/errors.js";
import type { AppInstallationRecord, AppReleaseState } from "../domain/records.js";
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
  readonly candidateConfiguration?: Readonly<Record<string, unknown>> | null;
  readonly candidateRevision?: string | null;
  readonly activeRevision?: string | null;
  readonly executionDeniedAt?: Date | null;
  readonly health?: Readonly<Record<string, unknown>>;
}

/**
 * Moving the active pointer, fenced on the release still being the one the operator
 * approved. The predicates sit in the same statement as the write, so a revocation cannot
 * land between a check and a commit and leave an active pointer to an ineligible release.
 */
export interface ActivateAppInstallationInput {
  readonly releaseId: string;
  readonly admissionPolicyVersion: string;
  readonly manifestDigest: string;
  /** The mapping revision going live with this activation. */
  readonly activeRevision: string;
  /**
   * Which release states may go live here. A first activation admits only `admitted`; a
   * re-enable of an installation that already exists also admits `deprecated`, because
   * deprecation stops new installs rather than the App an operator already runs.
   */
  readonly allowedReleaseStates: readonly AppReleaseState[];
}

export interface AppInstallationRepositoryPort {
  create(input: CreateAppInstallationInput): Promise<AppInstallationRecord>;
  findById(workspaceId: string, id: string): Promise<AppInstallationRecord | null>;
  /**
   * Workspace-free read for the execution path, which is handed an installation id by a
   * runtime and has no workspace scope of its own to check it against.
   */
  findAnyById(id: string): Promise<AppInstallationRecord | null>;
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
  /**
   * Moves the active pointer and reopens execution in the same statement. `null` when the
   * version no longer matches *or* the release is no longer eligible; the caller
   * distinguishes the two by re-reading the release inside the same transaction.
   */
  activateRelease(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    input: ActivateAppInstallationInput,
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
  "candidate_configuration",
  "candidate_revision",
  "active_revision",
  "execution_denied_at",
  "version",
  "health",
  "created_at",
  "updated_at",
] as const;

/**
 * The same columns, qualified. An update that joins `app_releases` sees `id`, `state`,
 * `version`, and the timestamps on both sides, so the returning list has to say which.
 */
const QUALIFIED_COLUMNS = [
  "app_installations.id as id",
  "app_installations.workspace_id as workspace_id",
  "app_installations.app_id as app_id",
  "app_installations.active_release_id as active_release_id",
  "app_installations.candidate_release_id as candidate_release_id",
  "app_installations.state as state",
  "app_installations.configuration as configuration",
  "app_installations.candidate_configuration as candidate_configuration",
  "app_installations.candidate_revision as candidate_revision",
  "app_installations.active_revision as active_revision",
  "app_installations.execution_denied_at as execution_denied_at",
  "app_installations.version as version",
  "app_installations.health as health",
  "app_installations.created_at as created_at",
  "app_installations.updated_at as updated_at",
] as const;

interface AppInstallationRow {
  id: string;
  workspace_id: string;
  app_id: string;
  active_release_id: string | null;
  candidate_release_id: string | null;
  state: string;
  configuration: unknown;
  candidate_configuration: unknown;
  candidate_revision: string | null;
  active_revision: string | null;
  execution_denied_at: Date | null;
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
  candidateConfiguration: row.candidate_configuration === null || row.candidate_configuration === undefined
    ? null
    : asObject(row.candidate_configuration),
  candidateRevision: row.candidate_revision,
  activeRevision: row.active_revision,
  executionDeniedAt: row.execution_denied_at ? new Date(row.execution_denied_at) : null,
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

  async findAnyById(id: string): Promise<AppInstallationRecord | null> {
    const row = await this.db
      .selectFrom("app_installations")
      .select(COLUMNS)
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
        ...(mutation.candidateConfiguration === undefined
          ? {}
          : { candidate_configuration: mutation.candidateConfiguration === null ? null : toJsonb(mutation.candidateConfiguration) }),
        ...(mutation.candidateRevision === undefined ? {} : { candidate_revision: mutation.candidateRevision }),
        ...(mutation.activeRevision === undefined ? {} : { active_revision: mutation.activeRevision }),
        ...(mutation.executionDeniedAt === undefined ? {} : { execution_denied_at: mutation.executionDeniedAt }),
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

  async activateRelease(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    input: ActivateAppInstallationInput,
  ): Promise<AppInstallationRecord | null> {
    const row = await this.db
      .updateTable("app_installations")
      .from("app_releases")
      .set({
        state: "active",
        active_release_id: input.releaseId,
        candidate_release_id: null,
        active_revision: input.activeRevision,
        // Disable and removal close the execution gate in their first transaction. Going
        // live is what reopens it, and it has to be the same commit that says the
        // installation is active — an installation that is `active` and still denied would
        // report itself healthy while refusing every invocation.
        execution_denied_at: null,
        version: expectedVersion + 1,
        updated_at: new Date(),
      })
      .where("app_installations.workspace_id", "=", workspaceId)
      .where("app_installations.id", "=", id)
      .where("app_installations.version", "=", expectedVersion)
      .where("app_releases.id", "=", input.releaseId)
      .where("app_releases.state", "in", [...input.allowedReleaseStates])
      .where("app_releases.admission_policy_version", "=", input.admissionPolicyVersion)
      .where("app_releases.manifest_digest", "=", input.manifestDigest)
      .returning(QUALIFIED_COLUMNS)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }
}
