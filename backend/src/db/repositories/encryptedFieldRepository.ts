import { sql, type Kysely } from "kysely";

import type { DB } from "../../shared/infra/kysely/schema.js";

/**
 * How ciphertext sits in a column: the whole value (`text`), or the string values of a JSON object
 * that decrypt under a configured key (`json_object_values`, for connector configs, which keep
 * secret and plain fields side by side).
 */
type EncryptedFieldShape = "text" | "json_object_values";

export interface EncryptedFieldLocation {
  /** `table.column`, as the re-encryption report prints it. */
  readonly label: string;
  readonly table: string;
  /** The row's primary key columns, in order. */
  readonly keyColumns: readonly string[];
  readonly column: string;
  readonly shape: EncryptedFieldShape;
}

/** One stored row: its primary key, as text, and the encrypted column, as text. */
export interface EncryptedFieldRow {
  key: readonly string[];
  value: string;
}

type ColumnOf<T extends keyof DB> = Extract<keyof DB[T], string>;

const location = <T extends Extract<keyof DB, string>>(spec: {
  table: T;
  keyColumns: readonly [ColumnOf<T>, ...ColumnOf<T>[]];
  column: ColumnOf<T>;
  shape: EncryptedFieldShape;
}): EncryptedFieldLocation => ({ ...spec, label: `${spec.table}.${spec.column}` });

/**
 * Every column that holds values encrypted under CONNECTOR_ENCRYPTION_KEY through `fieldEncryption.ts`.
 * The credential re-encryption command moves exactly these onto the current key, so a new encrypted
 * column adds its entry here. Name such a column `*_ciphertext`: a unit test checks every column whose
 * name contains `ciphertext`, `sealed` or `encrypted` against this list.
 */
export const ENCRYPTED_FIELD_LOCATIONS: readonly EncryptedFieldLocation[] = [
  location({ table: "connector_configs", keyColumns: ["id"], column: "config_data", shape: "json_object_values" }),
  location({ table: "integration_oauth_connections", keyColumns: ["id"], column: "credential_ciphertext", shape: "text" }),
  location({ table: "integration_oauth_connections", keyColumns: ["id"], column: "oauth_client_ciphertext", shape: "text" }),
  location({ table: "integration_oauth_connections", keyColumns: ["id"], column: "oauth_flow_ciphertext", shape: "text" }),
  location({ table: "mcp_connections", keyColumns: ["id"], column: "credential_ciphertext", shape: "text" }),
  location({ table: "mcp_connections", keyColumns: ["id"], column: "oauth_client_ciphertext", shape: "text" }),
  location({ table: "mcp_connections", keyColumns: ["id"], column: "oauth_flow_ciphertext", shape: "text" }),
  location({
    table: "workspace_provider_credentials",
    keyColumns: ["workspace_id", "provider"],
    column: "ciphertext",
    shape: "text",
  }),
  location({ table: "workspace_webhook_destinations", keyColumns: ["id"], column: "secret_ciphertext", shape: "text" }),
];

/**
 * Reads and rewrites one encrypted column at a time, for the credential re-encryption command. The
 * table and columns vary per location, so the queries quote them with `sql.table` / `sql.ref`
 * rather than going through the typed builder; they come only from `ENCRYPTED_FIELD_LOCATIONS`,
 * never from input, and every value is a bound parameter.
 */
export class EncryptedFieldRepository {
  constructor(private readonly db: Kysely<DB>) {}

  /** Up to `limit` rows with a value, in primary key order, after the row keyed `after`. */
  async readBatch(
    location: EncryptedFieldLocation,
    after: readonly string[] | null,
    limit: number,
  ): Promise<EncryptedFieldRow[]> {
    const keyColumns = sql.join(location.keyColumns.map((column) => sql.ref(column)));
    const keyText = sql.join(location.keyColumns.map((column) => sql`${sql.ref(column)}::text`));
    const afterKey = after === null ? sql`` : sql`AND (${keyColumns}) > (${sql.join(after)})`;
    const { rows } = await sql<{ key: string[]; value: string }>`
      SELECT ARRAY[${keyText}] AS key, ${sql.ref(location.column)}::text AS value
      FROM ${sql.table(location.table)}
      WHERE ${sql.ref(location.column)} IS NOT NULL ${afterKey}
      ORDER BY ${keyColumns}
      LIMIT ${limit}
    `.execute(this.db);
    return rows;
  }

  /**
   * Writes `next` only while the row still holds `expected`, so a credential edited since it was
   * read keeps the edit. Returns whether the row was written.
   */
  async compareAndSwap(
    location: EncryptedFieldLocation,
    key: readonly string[],
    expected: string,
    next: string,
  ): Promise<boolean> {
    if (key.length !== location.keyColumns.length) {
      throw new Error(`${location.label}: a row key needs ${location.keyColumns.length} values`);
    }
    const matchesKey = sql.join(
      location.keyColumns.map((column, index) => sql`${sql.ref(column)} = ${key[index]}`),
      sql` AND `,
    );
    const result = await sql`
      UPDATE ${sql.table(location.table)}
      SET ${sql.ref(location.column)} = ${next}
      WHERE ${matchesKey} AND ${sql.ref(location.column)}::text = ${expected}
    `.execute(this.db);
    return (result.numAffectedRows ?? 0n) > 0n;
  }
}
