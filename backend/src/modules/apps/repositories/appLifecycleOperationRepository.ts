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

export interface ReserveAppLifecycleOperationInput {
  readonly workspaceId: string;
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
 * What a driver believes it holds. Every write below states it, and an update that matches
 * nothing means another driver owns this operation — so this one stops rather than run the
 * step twice or tear down a step the other driver just completed.
 */
interface AppLifecycleOperationOwnership {
  readonly expectedState: AppLifecycleOperationState;
  readonly expectedStep: AppSagaStepId | null;
  /** Checked only when given, which is what a reverse runner states instead of a forward one. */
  readonly expectedCompensationStep?: AppSagaStepId | null;
  readonly leaseOwner: string;
}

export interface ClaimAppLifecycleStepInput {
  readonly expectedState: AppLifecycleOperationState;
  readonly expectedStep: AppSagaStepId | null;
  readonly expectedCompensationStep?: AppSagaStepId | null;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
  /** A lease that lapsed before this instant is free, whoever wrote it. */
  readonly now: Date;
}

export interface AdvanceAppLifecycleOperationInput extends AppLifecycleOperationOwnership {
  readonly step: AppSagaStepId;
}

export interface AdvanceAppLifecycleCompensationInput extends AppLifecycleOperationOwnership {
  readonly compensationStep: AppSagaStepId;
}

export interface FinishAppLifecycleOperationInput extends AppLifecycleOperationOwnership {
  readonly state: AppLifecycleOperationState;
  readonly error: { readonly reason: string; readonly message: string } | null;
  readonly compensationStep?: AppSagaStepId | null;
}

export interface AppLifecycleOperationRepositoryPort {
  /**
   * Inserts the operation, or reports that this workspace already used this idempotency
   * key. It never throws on that conflict: the caller reads the existing operation in the
   * same healthy transaction and compares fingerprints, because a query issued after a
   * failed insert would run inside an aborted transaction and fail with 25P02.
   *
   * The one conflict it does translate is the in-flight fence, which is a different
   * statement — this installation already has an operation that owns it.
   */
  reserve(input: ReserveAppLifecycleOperationInput): Promise<AppLifecycleOperationRecord | null>;
  findById(id: string): Promise<AppLifecycleOperationRecord | null>;
  update(id: string, mutation: AppLifecycleOperationMutation): Promise<AppLifecycleOperationRecord>;
  /**
   * Takes the exact (operation, state, step) this driver is about to act on. `null` means
   * another driver holds an unexpired lease on it, or the cursor already moved.
   */
  claim(id: string, input: ClaimAppLifecycleStepInput): Promise<AppLifecycleOperationRecord | null>;
  /** Gives the claim back without changing anything, so a paused operation stays resumable. */
  release(id: string, leaseOwner: string): Promise<void>;
  /** `null` when the compare-and-set matched no row. */
  advance(id: string, input: AdvanceAppLifecycleOperationInput): Promise<AppLifecycleOperationRecord | null>;
  advanceCompensation(
    id: string,
    input: AdvanceAppLifecycleCompensationInput,
  ): Promise<AppLifecycleOperationRecord | null>;
  /** The one writer of a terminal or compensating state, and it is a compare-and-set too. */
  finish(id: string, input: FinishAppLifecycleOperationInput): Promise<AppLifecycleOperationRecord | null>;
  listByInstallation(installationId: string, limit: number): Promise<AppLifecycleOperationRecord[]>;
  findByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<AppLifecycleOperationRecord | null>;
  /**
   * The installation's operation still holding it: running, rolling back, or stopped with
   * an unfinished rollback. A caller uses this to fast-fail a second command rather than
   * let two sagas run at once, and to find the installation that needs repair.
   */
  findActiveByInstallation(installationId: string): Promise<AppLifecycleOperationRecord | null>;
}

const COLUMNS = [
  "id",
  "workspace_id",
  "installation_id",
  "kind",
  "state",
  "step",
  "compensation_step",
  "lease_owner",
  "lease_expires_at",
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
  workspace_id: string;
  installation_id: string;
  kind: string;
  state: string;
  step: string | null;
  compensation_step: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
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
    workspaceId: row.workspace_id,
    installationId: row.installation_id,
    kind: row.kind as AppLifecycleOperationKind,
    state: row.state as AppLifecycleOperationState,
    step: row.step as AppSagaStepId | null,
    compensationStep: row.compensation_step as AppSagaStepId | null,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : null,
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

// Migration 171 allows one operation per installation while it is running, rolling back,
// or stopped with an unfinished rollback. Its violation is the one Postgres error this
// insert expects to see and translates, rather than letting a raw SQLSTATE leak out.
const IN_FLIGHT_UNIQUE_CONSTRAINT = "idx_app_lifecycle_operations_in_flight";

const isInFlightViolation = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && candidate.constraint === IN_FLIGHT_UNIQUE_CONSTRAINT;
};

/** The states that still own their installation, so no new command may start beside them. */
const appOperationHoldingStates = ["running", "compensating", "compensation_failed"] as const;

export class AppLifecycleOperationRepository implements AppLifecycleOperationRepositoryPort {
  constructor(private readonly db: Db) {}

  async reserve(input: ReserveAppLifecycleOperationInput): Promise<AppLifecycleOperationRecord | null> {
    try {
      const inserted = await this.db
        .insertInto("app_lifecycle_operations")
        .values({
          id: randomUUID(),
          workspace_id: input.workspaceId,
          installation_id: input.installationId,
          kind: input.kind,
          state: "running",
          step: null,
          compensation_step: null,
          lease_owner: null,
          lease_expires_at: null,
          idempotency_key: input.idempotencyKey,
          request_fingerprint: input.requestFingerprint,
          initiated_by: toJsonb(input.initiatedBy),
          payload: toJsonb(input.payload),
        })
        .onConflict((conflict) => conflict.columns(["workspace_id", "idempotency_key"]).doNothing())
        .returning(COLUMNS)
        .executeTakeFirst();
      return inserted ? mapRecord(inserted) : null;
    } catch (error) {
      if (isInFlightViolation(error)) {
        throw new AppsError(
          "operation_in_progress",
          "Another lifecycle operation is already running for this installation.",
          { installationId: input.installationId },
        );
      }
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

  async claim(id: string, input: ClaimAppLifecycleStepInput): Promise<AppLifecycleOperationRecord | null> {
    let query = this.db
      .updateTable("app_lifecycle_operations")
      .set({ lease_owner: input.leaseOwner, lease_expires_at: input.leaseExpiresAt, updated_at: new Date() })
      .where("id", "=", id)
      .where("state", "=", input.expectedState)
      .where((eb) => eb.or([
        eb("lease_owner", "is", null),
        eb("lease_owner", "=", input.leaseOwner),
        eb("lease_expires_at", "<=", input.now),
      ]));
    query = input.expectedStep === null
      ? query.where("step", "is", null)
      : query.where("step", "=", input.expectedStep);
    if (input.expectedCompensationStep !== undefined) {
      query = input.expectedCompensationStep === null
        ? query.where("compensation_step", "is", null)
        : query.where("compensation_step", "=", input.expectedCompensationStep);
    }
    const row = await query.returning(COLUMNS).executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  async release(id: string, leaseOwner: string): Promise<void> {
    await this.db
      .updateTable("app_lifecycle_operations")
      .set({ lease_owner: null, lease_expires_at: null, updated_at: new Date() })
      .where("id", "=", id)
      .where("lease_owner", "=", leaseOwner)
      .execute();
  }

  async advance(
    id: string,
    input: AdvanceAppLifecycleOperationInput,
  ): Promise<AppLifecycleOperationRecord | null> {
    const row = await this.owned(id, input)
      .set({ step: input.step, updated_at: new Date() })
      .returning(COLUMNS)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  async advanceCompensation(
    id: string,
    input: AdvanceAppLifecycleCompensationInput,
  ): Promise<AppLifecycleOperationRecord | null> {
    const row = await this.owned(id, input)
      .set({ compensation_step: input.compensationStep, updated_at: new Date() })
      .returning(COLUMNS)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  async finish(
    id: string,
    input: FinishAppLifecycleOperationInput,
  ): Promise<AppLifecycleOperationRecord | null> {
    const terminal = input.state !== "running" && input.state !== "compensating";
    const row = await this.owned(id, input)
      .set({
        state: input.state,
        error: input.error === null ? null : toJsonb(input.error),
        ...(input.compensationStep === undefined ? {} : { compensation_step: input.compensationStep }),
        // A terminal operation owns no driver. A compensating one keeps its lease, because
        // the driver that opened the rollback is the one that runs it.
        ...(terminal ? { lease_owner: null, lease_expires_at: null } : {}),
        updated_at: new Date(),
      })
      .returning(COLUMNS)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  private owned(id: string, ownership: AppLifecycleOperationOwnership) {
    let query = this.db
      .updateTable("app_lifecycle_operations")
      .where("id", "=", id)
      .where("state", "=", ownership.expectedState);
    // The repair removal is the sole transition out of `compensation_failed`.
    // Terminal operations own no lease, and its caller deliberately supplies the empty
    // repair token to require that NULL shape rather than bypassing the state/step CAS.
    query = ownership.leaseOwner === ""
      ? query.where("lease_owner", "is", null)
      : query.where("lease_owner", "=", ownership.leaseOwner);
    query = ownership.expectedStep === null
      ? query.where("step", "is", null)
      : query.where("step", "=", ownership.expectedStep);
    if (ownership.expectedCompensationStep !== undefined) {
      query = ownership.expectedCompensationStep === null
        ? query.where("compensation_step", "is", null)
        : query.where("compensation_step", "=", ownership.expectedCompensationStep);
    }
    return query;
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

  async findByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<AppLifecycleOperationRecord | null> {
    const row = await this.db
      .selectFrom("app_lifecycle_operations")
      .select(COLUMNS)
      .where("workspace_id", "=", workspaceId)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }

  async findActiveByInstallation(installationId: string): Promise<AppLifecycleOperationRecord | null> {
    const row = await this.db
      .selectFrom("app_lifecycle_operations")
      .select(COLUMNS)
      .where("installation_id", "=", installationId)
      .where("state", "in", [...appOperationHoldingStates])
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? mapRecord(row) : null;
  }
}
