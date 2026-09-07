import { randomUUID } from "node:crypto";

import { toJsonb } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type { AppConnectionKind } from "../domain/connectionBinding.js";
import type { AppConnectionRecord } from "../domain/records.js";

export interface BindAppConnectionInput {
  readonly installationId: string;
  readonly slotId: string;
  readonly kind: AppConnectionKind;
  readonly publicFields: Readonly<Record<string, string>>;
  readonly secretCiphertext: string | null;
  readonly encryptionKeyId: string | null;
}

/**
 * There is no read path for `secret_ciphertext` here. The control plane writes secret
 * material and never reads it back; the invocation path that will lives in `appRuntime`
 * and gets its own port.
 */
export interface AppConnectionRepositoryPort {
  bind(input: BindAppConnectionInput): Promise<AppConnectionRecord>;
  listByInstallation(installationId: string): Promise<AppConnectionRecord[]>;
  markAllForDeletion(installationId: string, requestedAt: Date): Promise<number>;
}

const COLUMNS = [
  "id",
  "installation_id",
  "slot_id",
  "kind",
  "public_fields",
  "created_at",
  "updated_at",
  "rotated_at",
  "deletion_requested_at",
] as const;

interface AppConnectionRow {
  id: string;
  installation_id: string;
  slot_id: string;
  kind: string;
  public_fields: unknown;
  created_at: Date;
  updated_at: Date;
  rotated_at: Date | null;
  deletion_requested_at: Date | null;
  has_secret?: boolean | null;
}

const asPublicFields = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => typeof entry === "string") as Array<[string, string]>,
  );
};

const mapRecord = (row: AppConnectionRow): AppConnectionRecord => ({
  id: row.id,
  installationId: row.installation_id,
  slotId: row.slot_id,
  kind: row.kind as AppConnectionKind,
  publicFields: asPublicFields(row.public_fields),
  hasSecret: Boolean(row.has_secret),
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  rotatedAt: row.rotated_at ? new Date(row.rotated_at) : null,
  deletionRequestedAt: row.deletion_requested_at ? new Date(row.deletion_requested_at) : null,
});

export class AppConnectionRepository implements AppConnectionRepositoryPort {
  constructor(private readonly db: Db) {}

  async bind(input: BindAppConnectionInput): Promise<AppConnectionRecord> {
    const now = new Date();
    const row = await this.db
      .insertInto("app_connections")
      .values({
        id: randomUUID(),
        installation_id: input.installationId,
        slot_id: input.slotId,
        kind: input.kind,
        public_fields: toJsonb(input.publicFields),
        secret_ciphertext: input.secretCiphertext,
        encryption_key_id: input.encryptionKeyId,
      })
      .onConflict((conflict) => conflict.columns(["installation_id", "slot_id"]).doUpdateSet({
        kind: input.kind,
        public_fields: toJsonb(input.publicFields),
        secret_ciphertext: input.secretCiphertext,
        encryption_key_id: input.encryptionKeyId,
        updated_at: now,
        rotated_at: now,
        deletion_requested_at: null,
      }))
      .returning([...COLUMNS, (eb) => eb("secret_ciphertext", "is not", null).as("has_secret")])
      .executeTakeFirstOrThrow();
    return mapRecord(row as AppConnectionRow);
  }

  async listByInstallation(installationId: string): Promise<AppConnectionRecord[]> {
    const rows = await this.db
      .selectFrom("app_connections")
      .select([...COLUMNS, (eb) => eb("secret_ciphertext", "is not", null).as("has_secret")])
      .where("installation_id", "=", installationId)
      .orderBy("slot_id")
      .execute();
    return rows.map((row) => mapRecord(row as AppConnectionRow));
  }

  async markAllForDeletion(installationId: string, requestedAt: Date): Promise<number> {
    const rows = await this.db
      .updateTable("app_connections")
      .set({ deletion_requested_at: requestedAt, updated_at: requestedAt })
      .where("installation_id", "=", installationId)
      .where("deletion_requested_at", "is", null)
      .returning("id")
      .execute();
    return rows.length;
  }
}
