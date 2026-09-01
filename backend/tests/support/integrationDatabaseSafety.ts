import {
  assertIntegrationDatabaseIdentityIsSafe as assertIntegrationDatabaseIdentityIsSafePolicy,
  assertIntegrationDatabaseUrlIsSafe,
  assertMarkedIntegrationDatabase as assertMarkedIntegrationDatabasePolicy,
  INTEGRATION_DATABASE_MARKER,
  requireIntegrationDatabaseUrl,
  shouldGuardIntegrationTests,
  type AssertMarkedIntegrationDatabaseInput,
  type IntegrationDatabaseIdentity,
} from "@radioso/integration-test-support";
import { Pool } from "pg";

export {
  assertIntegrationDatabaseUrlIsSafe,
  INTEGRATION_DATABASE_MARKER,
  requireIntegrationDatabaseUrl,
  shouldGuardIntegrationTests,
  type IntegrationDatabaseIdentity,
};

type AssertMarkedIntegrationDatabaseOptions = Omit<AssertMarkedIntegrationDatabaseInput, "readIdentity"> & {
  readIdentity?: AssertMarkedIntegrationDatabaseInput["readIdentity"];
};

export const readIntegrationDatabaseIdentity = async (
  databaseUrl: string,
): Promise<IntegrationDatabaseIdentity> => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    const result = await pool.query<IntegrationDatabaseIdentity>(`
      SELECT
        current_database() AS "databaseName",
        database.oid::text AS "databaseOid",
        (pg_control_system()).system_identifier::text AS "clusterIdentifier",
        shobj_description(database.oid, 'pg_database') AS marker
      FROM pg_database AS database
      WHERE database.datname = current_database()
    `);
    const identity = result.rows[0];
    if (!identity) {
      throw new Error("PostgreSQL did not return its current database identity");
    }
    return identity;
  } finally {
    await pool.end().catch(() => undefined);
  }
};

export const assertMarkedIntegrationDatabase = async (
  input: AssertMarkedIntegrationDatabaseOptions,
): Promise<IntegrationDatabaseIdentity> => assertMarkedIntegrationDatabasePolicy({
  ...input,
  readIdentity: input.readIdentity ?? readIntegrationDatabaseIdentity,
});

export const assertIntegrationDatabaseIdentityIsSafe = async (
  input: AssertMarkedIntegrationDatabaseOptions,
): Promise<IntegrationDatabaseIdentity> => assertIntegrationDatabaseIdentityIsSafePolicy({
  ...input,
  readIdentity: input.readIdentity ?? readIntegrationDatabaseIdentity,
});
