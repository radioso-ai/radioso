import { randomUUID } from "node:crypto";

import { toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import { AppsError } from "../domain/errors.js";
import type {
  AppLifecycleOperationKind,
  AppLifecycleOperationState,
  AppSagaStepId,
} from "../domain/lifecycle.js";
import type { AppLifecycleOperationRecord } from "../domain/records.js";
import type { AppOperatorPrincipal } from "../ports/operatorAuthorization.js";

export interface StartAppLifecycleOperationInput {
  readonly installationId: string;
  readonly kind: AppLifecycleOperationKind;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly initiatedBy: AppOperatorPrincipal;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AppLifecycleOperationMutation {
  readonly state?: AppLifecycleOperationState;
  readonly step?: AppSagaStepId | null;
  readonly compensationStep?: AppSagaStepId | null;
  readonly error?: { readonly reason: string; readonly message: string } | null;
}

/**
 * A compare-and-set advance. The driver states the cursor and state it believes it holds;
 * an update that matches nothing means another driver owns this operation and this one
 * must stop rather than run the next step twice.
 */
export interface AdvanceAppLifecycleOperationInput {
  readonly expectedState: AppLifecycleOperationState;
  readonly expectedStep: AppSagaStepId | null;
  readonly step: AppSagaStepId;
}

export interface AdvanceAppLifecycleCompensationInput {
  readonly expectedCompensationStep: AppSagaStepId | null;
  readonly compensationStep: AppSagaStepId;
}

export interface AppLifecycleOperationRepositoryPort {
  /**
   * Refuses with `operation_in_progress` when the installation already has an operation
   * in flight, and returns the existing record when this exact idempotency key was
   * already used, so a retried command resumes one saga instead of starting a second.
   */
  start(input: StartAppLifecycleOperationInput): Promise<{
    readonly operation: AppLifecycleOperationRecord;
    readonly created: boolean;
  }>;
  findById(id: string): Promise<AppLifecycleOperationRecord | null>;
  update(id: string, mutation: AppLifecycleOperationMutation): Promise<AppLifecycleOperationRecord>;
  /** `null` when the compare-and-set matched no row. */
  advance(id: string, input: AdvanceAppLifecycleOperationInput): Promise<AppLifecycleOperationRecord | null>;
  advanceCompensation(
    id: string,
    input: AdvanceAppLifecycleCompensationInput,
  ): Promise<AppLifecycleOperationRecord | null>;
  listByInstallation(installationId: string, limit: number): Promise<AppLifecycleOperationRecord[]>;
  findByIdempotencyKey(idempotencyKey: string): Promise<AppLifecycleOperationRecord | null>;
  /**
   * The installation's operation still mid-flight, if any. A caller uses this to fast-fail
   * a second command against the same installation rather than let two sagas run at once.
   */
  findActiveByInstallation(installationId: string): Promise<AppLifecycleOperationRecord | null>;
}

const COLUMNS = [
  "id",
  "installation_id",
  "kind",
  "state",
  "step",
  "compensation_step",
  "idempotency_key",
  "request_fingerprint",
  "initiated_by",
  "payload",
  "error",
  "created_at",
  "updated_at",
] as const;

interface AppLifecycleOperationRow {
  id: string;
  installation_id: string;
  kind: string;
  state: string;
  step: string | null;
  compensation_step: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  initiated_by: unknown;
  payload: unknown;
  error: unknown;
  created_at: Date;
  updated_at: Date;
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Persisted JSONB is `unknown` on the way back; anything that is not text reads as absent. */
const asText = (value: unknown): string => (typeof value === "string" ? value : "");

const mapRecord = (row: AppLifecycleOperationRow): AppLifecycleOperationRecord => {
  const initiatedBy = asObject(row.initiated_by);
  const error = row.error ? asObject(row.error) : null;
  return {
    id: row.id,
    installationId: row.installation_id,
    kind: row.kind as AppLifecycleOperationKind,
    state: row.state as AppLifecycleOperationState,
    step: row.step as AppSagaStepId | null,
    compensationStep: row.compensation_step as AppSagaStepId | null,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    initiatedBy: {
      accountId: asText(initiatedBy.accountId),
      userId: asText(initiatedBy.userId),
    },
    payload: asObject(row.payload),
    error: error ? { reason: asText(error.reason), message: asText(error.message) } : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
};

// Migration 171 allows one `running`/`compensating` operation per installation. Its
// violation is the one Postgres error this insert expects to see and translates, rather
// than letting a raw SQLSTATE leak out of the repository.
const IN_FLIGHT_UNIQUE_CONSTRAINT = "idx_app_lifecycle_operations_in_flight";

const uniqueViolationConstraint = (error: unknown): string | null => {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; constraint?: unknown };
  if (candidate.code !== "23505") return null;
  return typeof candidate.constraint === "string" ? candidate.constraint : "";
};

export class AppLifecycleOperationRepository implements AppLifecycleOperationRepositoryPort {
  constructor(private readonly db: Db) {}

  async start(input: StartAppLifecycleOperationInput): Promise<{
    operation: AppLifecycleOperationRecord;
    created: boolean;
  }> {
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return { operation: existing, created: false };

    try {
      const inserted = await this.db
        .insertInto("app_lifecycle_operations")
        .values({
          id: randomUUID(),
          installation_id: input.installationId,
          kind: input.kind,
          state: "running",
          step: null,
          compensation_step: null,
          idempotency_key: input.idempotencyKey,
          request_fingerprint: input.requestFingerprint,
          initiated_by: toJsonb(input.initiatedBy),
          payload: toJsonb(input.payload),
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return { operation: mapRecord(inserted), created: true };
    } catch (error) {
      const constraint = uniqueViolationConstraint(error);
      if (constraint === null) throw error;
      if (constraint === IN_FLIGHT_UNIQUE_CONSTRAINT) {
        throw new AppsError(
          "operation_in_progress",
          "Another lifecycle operation is already running for this installation.",
          { installationId: input.installationId },
        );
      }
      // The idempotency key was taken between the read above and this insert: that is a
      // concurrent retry of the same command, so it resolves to the same operation.
      const raced = await this.findByIdempotencyKey(input.idempotencyKey);
      if (raced) return { operation: raced, created: false };
      throw error;
    }
  }

  async findById(id: string): Promise<AppLifecycleOperationRecord | null> {
    const row = await this.db
      .selectFrom("app_lifecycle_operations")
      .select(COLUMNS)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  async update(id: string, mutation: AppLifecycleOperationMutation): Promise<AppLifecycleOperationRecord> {
    const row = await this.db
      .updateTable("app_lifecycle_operations")
      .set({
        ...(mutation.state === undefined ? {} : { state: mutation.state }),
        ...(mutation.step === undefined ? {} : { step: mutation.step }),
        ...(mutation.compensationStep === undefined ? {} : { compensation_step: mutation.compensationStep }),
        ...(mutation.error === undefined ? {} : { error: mutation.error === null ? null : toJsonb(mutation.error) }),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return mapRecord(row);
  }

  async advance(
    id: string,
    input: AdvanceAppLifecycleOperationInput,
  ): Promise<AppLifecycleOperationRecord | null> {
    let query = this.db
      .updateTable("app_lifecycle_operations")
      .set({ step: input.step, updated_at: new Date() })
      .where("id", "=", id)
      .where("state", "=", input.expectedState);
    query = input.expectedStep === null
      ? query.where("step", "is", null)
      : query.where("step", "=", input.expectedStep);
    const row = await query.returning(COLUMNS).executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  async advanceCompensation(
    id: string,
    input: AdvanceAppLifecycleCompensationInput,
  ): Promise<AppLifecycleOperationRecord | null> {
    let query = this.db
      .updateTable("app_lifecycle_operations")
      .set({ compensation_step: input.compensationStep, updated_at: new Date() })
      .where("id", "=", id)
      .where("state", "=", "compensating");
    query = input.expectedCompensationStep === null
      ? query.where("compensation_step", "is", null)
      : query.where("compensation_step", "=", input.expectedCompensationStep);
    const row = await query.returning(COLUMNS).executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  async listByInstallation(installationId: string, limit: number): Promise<AppLifecycleOperationRecord[]> {
    const rows = await this.db
      .selectFrom("app_lifecycle_operations")
      .select(COLUMNS)
      .where("installation_id", "=", installationId)
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map((row) => mapRecord(row as AppLifecycleOperationRow));
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<AppLifecycleOperationRecord | null> {
    const row = await this.db
      .selectFrom("app_lifecycle_operations")
      .select(COLUMNS)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  async findActiveByInstallation(installationId: string): Promise<AppLifecycleOperationRecord | null> {
    const row = await this.db
      .selectFrom("app_lifecycle_operations")
      .select(COLUMNS)
      .where("installation_id", "=", installationId)
      .where("state", "in", ["running", "compensating"])
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }
}
