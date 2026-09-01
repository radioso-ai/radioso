import { existsSync } from "node:fs";

import { Pool } from "pg";

import {
  INTEGRATION_DATABASE_MARKER,
  assertIntegrationDatabaseIdentityIsSafe,
  assertIntegrationDatabaseUrlIsSafe,
  assertMarkedIntegrationDatabase,
} from "../tests/support/integrationDatabaseSafety.js";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
} else if (existsSync("../.env")) {
  process.loadEnvFile("../.env");
}

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;
if (!integrationDatabaseUrl) {
  throw new Error("INTEGRATION_DATABASE_URL is required to prepare an integration database");
}

const target = assertIntegrationDatabaseUrlIsSafe({
  integrationDatabaseUrl,
  applicationDatabaseUrl: process.env.DATABASE_URL,
  acknowledgedDatabaseName: process.env.RADIOSO_INTEGRATION_DATABASE_NAME,
  requireAcknowledgedDatabaseName: true,
});

await assertIntegrationDatabaseIdentityIsSafe({
  integrationDatabaseUrl,
  applicationDatabaseUrl: process.env.DATABASE_URL,
});

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;
const pool = new Pool({ connectionString: integrationDatabaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
try {
  await pool.query(
    `COMMENT ON DATABASE ${quoteIdentifier(target.databaseName)} IS '${INTEGRATION_DATABASE_MARKER}'`,
  );
} finally {
  await pool.end().catch(() => undefined);
}

await assertMarkedIntegrationDatabase({
  integrationDatabaseUrl,
  applicationDatabaseUrl: process.env.DATABASE_URL,
});

process.stdout.write(`Prepared disposable integration database ${target.display}.\n`);
