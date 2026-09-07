import { randomUUID } from "node:crypto";

import { toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
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
  readonly initiatedBy: AppOperatorPrincipal;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface AppLifecycleOperationMutation {
  readonly state?: AppLifecycleOperationState;
  readonly step?: AppSagaStepId | null;
  readonly error?: { readonly reason: string; readonly message: string } | null;
}

export interface AppLifecycleOperationRepositoryPort {
  /**
   * Returns the existing operation when the idempotency key was already used, so a
   * retried apply resumes one saga instead of starting a second.
   */
  start(input: StartAppLifecycleOperationInput): Promise<{
    readonly operation: AppLifecycleOperationRecord;
    readonly created: boolean;
  }>;
  findById(id: string): Promise<AppLifecycleOperationRecord | null>;
  update(id: string, mutation: AppLifecycleOperationMutation): Promise<AppLifecycleOperationRecord>;
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
  "idempotency_key",
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
  idempotency_key: string;
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
    idempotencyKey: row.idempotency_key,
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

export class AppLifecycleOperationRepository implements AppLifecycleOperationRepositoryPort {
  constructor(private readonly db: Db) {}

  async start(input: StartAppLifecycleOperationInput): Promise<{
    operation: AppLifecycleOperationRecord;
    created: boolean;
  }> {
    const inserted = await this.db
      .insertInto("app_lifecycle_operations")
      .values({
        id: randomUUID(),
        installation_id: input.installationId,
        kind: input.kind,
        state: "running",
        step: null,
        idempotency_key: input.idempotencyKey,
        initiated_by: toJsonb(input.initiatedBy),
        payload: toJsonb(input.payload),
      })
      .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
      .returning(COLUMNS)
      .executeTakeFirst();
    if (inserted) return { operation: mapRecord(inserted), created: true };

    const existing = await this.db
      .selectFrom("app_lifecycle_operations")
      .select(COLUMNS)
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirstOrThrow();
    return { operation: mapRecord(existing), created: false };
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
        ...(mutation.error === undefined ? {} : { error: mutation.error === null ? null : toJsonb(mutation.error) }),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return mapRecord(row);
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
