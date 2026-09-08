import { randomUUID } from "node:crypto";

import type { AppManifest } from "@radioso/app-contract";

import { toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { AppReleaseRecord, AppReleaseState } from "../domain/records.js";

export interface InsertAppReleaseInput {
  readonly appId: string;
  readonly version: string;
  readonly manifest: AppManifest;
  readonly manifestDigest: string;
  readonly artifactDigest: string;
  readonly publisherId: string;
  readonly state: AppReleaseState;
  readonly admissionPolicyVersion: string;
  readonly admissionDecision: Readonly<Record<string, unknown>>;
}

/**
 * The predicates a release has to still satisfy at the instant an authority is committed.
 * Reading this inside the committing transaction takes a share lock on the release row, so
 * a revocation racing the commit waits for it rather than slipping in between the check
 * and the write.
 */
export interface AppReleaseEligibilityFence {
  readonly releaseId: string;
  readonly admissionPolicyVersion: string;
  readonly manifestDigest: string;
  readonly allowedStates: readonly AppReleaseState[];
}

export interface AppReleaseRepositoryPort {
  /**
   * Inserts a release that does not exist yet and returns `null` when one already does.
   * There is deliberately no update path here: a release version is immutable, and its
   * security state changes only through {@link AppReleaseRepositoryPort.transitionState},
   * so a registry re-sync at start-up can never resurrect a revoked or quarantined row.
   */
  insertIfAbsent(input: InsertAppReleaseInput): Promise<AppReleaseRecord | null>;
  /** The one writer of a release's state, used by explicit deprecate/revoke/quarantine. */
  transitionState(id: string, state: AppReleaseState): Promise<AppReleaseRecord | null>;
  /** `null` when the release no longer satisfies the fence, which is a refusal, not an error. */
  lockEligible(input: AppReleaseEligibilityFence): Promise<AppReleaseRecord | null>;
  findByAppIdAndVersion(appId: string, version: string): Promise<AppReleaseRecord | null>;
  findById(id: string): Promise<AppReleaseRecord | null>;
  listInstallable(): Promise<AppReleaseRecord[]>;
}

const COLUMNS = [
  "id",
  "app_id",
  "version",
  "manifest",
  "manifest_digest",
  "artifact_digest",
  "publisher_id",
  "state",
  "admission_policy_version",
  "admission_decision",
  "created_at",
  "updated_at",
] as const;

interface AppReleaseRow {
  id: string;
  app_id: string;
  version: string;
  manifest: unknown;
  manifest_digest: string;
  artifact_digest: string;
  publisher_id: string;
  state: string;
  admission_policy_version: string;
  admission_decision: unknown;
  created_at: Date;
  updated_at: Date;
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const mapRecord = (row: AppReleaseRow): AppReleaseRecord => ({
  id: row.id,
  appId: row.app_id,
  version: row.version,
  manifest: row.manifest as AppManifest,
  manifestDigest: row.manifest_digest,
  artifactDigest: row.artifact_digest,
  publisherId: row.publisher_id,
  state: row.state as AppReleaseState,
  admissionPolicyVersion: row.admission_policy_version,
  admissionDecision: asObject(row.admission_decision),
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class AppReleaseRepository implements AppReleaseRepositoryPort {
  constructor(private readonly db: Db) {}

  async insertIfAbsent(input: InsertAppReleaseInput): Promise<AppReleaseRecord | null> {
    const row = await this.db
      .insertInto("app_releases")
      .values({
        id: randomUUID(),
        app_id: input.appId,
        version: input.version,
        manifest: toJsonb(input.manifest),
        manifest_digest: input.manifestDigest,
        artifact_digest: input.artifactDigest,
        publisher_id: input.publisherId,
        state: input.state,
        admission_policy_version: input.admissionPolicyVersion,
        admission_decision: toJsonb(input.admissionDecision),
      })
      .onConflict((conflict) => conflict.columns(["app_id", "version"]).doNothing())
      .returning(COLUMNS)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  async transitionState(id: string, state: AppReleaseState): Promise<AppReleaseRecord | null> {
    const row = await this.db
      .updateTable("app_releases")
      .set({ state, updated_at: new Date() })
      .where("id", "=", id)
      .returning(COLUMNS)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  async lockEligible(input: AppReleaseEligibilityFence): Promise<AppReleaseRecord | null> {
    const row = await this.db
      .selectFrom("app_releases")
      .select(COLUMNS)
      .where("id", "=", input.releaseId)
      .where("state", "in", [...input.allowedStates])
      .where("admission_policy_version", "=", input.admissionPolicyVersion)
      .where("manifest_digest", "=", input.manifestDigest)
      .forShare()
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  async findByAppIdAndVersion(appId: string, version: string): Promise<AppReleaseRecord | null> {
    const row = await this.db
      .selectFrom("app_releases")
      .select(COLUMNS)
      .where("app_id", "=", appId)
      .where("version", "=", version)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  async findById(id: string): Promise<AppReleaseRecord | null> {
    const row = await this.db
      .selectFrom("app_releases")
      .select(COLUMNS)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  /** Admitted only. A deprecated release stays installed but is not offered for new installs. */
  async listInstallable(): Promise<AppReleaseRecord[]> {
    const rows = await this.db
      .selectFrom("app_releases")
      .select(COLUMNS)
      .where("state", "=", "admitted")
      .orderBy("app_id")
      .orderBy("version")
      .execute();
    return rows.map((row) => mapRecord(row as AppReleaseRow));
  }
}
