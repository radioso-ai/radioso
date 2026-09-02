import {
  assertMarkedIntegrationDatabase,
  requireIntegrationDatabaseUrl,
  type IntegrationDatabaseIdentity,
} from "@radioso/integration-test-support";
import { Pool } from "pg";

const databaseTestFiles = [
  "organizationCreationGuard.integration.test.ts",
  "organizationDirectoryService.integration.test.ts",
  "staffConsoleMigrator.integration.test.ts",
  "usageLimitRoutes.test.ts",
  "usageLimitService.integration.test.ts",
];

const selectsDatabaseTests = (argv: readonly string[]): boolean => {
  const selectedTestFiles = argv.filter((argument) => /\.test\.[cm]?[jt]sx?\b/.test(argument));
  return selectedTestFiles.length === 0 || selectedTestFiles.some((file) => databaseTestFiles.some((name) => file.endsWith(name)));
};

const readIntegrationDatabaseIdentity = async (
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

export default async function integrationDatabaseGlobalSetup(): Promise<void> {
  if (!selectsDatabaseTests(process.argv)) {
    return;
  }

  const integrationDatabaseUrl = requireIntegrationDatabaseUrl(process.env.INTEGRATION_DATABASE_URL);
  await assertMarkedIntegrationDatabase({
    integrationDatabaseUrl,
    applicationDatabaseUrl: process.env.DATABASE_URL,
    readIdentity: readIntegrationDatabaseIdentity,
  });
}
