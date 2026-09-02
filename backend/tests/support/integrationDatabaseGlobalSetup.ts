import { existsSync } from "node:fs";

import {
  assertMarkedIntegrationDatabase,
  requireIntegrationDatabaseUrl,
  shouldGuardIntegrationTests,
} from "./integrationDatabaseSafety.js";

const loadLocalEnvironment = (): void => {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  } else if (existsSync("../.env")) {
    process.loadEnvFile("../.env");
  }
};

export default async function integrationDatabaseGlobalSetup(): Promise<void> {
  if (!shouldGuardIntegrationTests(process.argv)) {
    return;
  }

  loadLocalEnvironment();
  const integrationDatabaseUrl = requireIntegrationDatabaseUrl(process.env.INTEGRATION_DATABASE_URL);

  await assertMarkedIntegrationDatabase({
    integrationDatabaseUrl,
    applicationDatabaseUrl: process.env.DATABASE_URL,
  });
}
