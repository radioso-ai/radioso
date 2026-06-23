import { describe } from "vitest";

import { Database } from "../../../src/shared/infra/database.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReach = async (url: string): Promise<boolean> => {
  const database = new Database(url);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

/**
 * Resolves the integration-test database gate for repository suites.
 *
 * - URL unset -> skip silently (local dev without a database).
 * - URL set but unreachable -> THROW. A misconfigured CI must fail loudly; it must never
 *   go green by silently skipping the only coverage these migrated repositories have.
 * - URL set and reachable -> run.
 *
 * The thrown message includes only the host (never credentials).
 */
export const resolveIntegrationDatabase = async (): Promise<{
  describeIntegration: typeof describe;
  integrationDatabaseUrl: string;
}> => {
  if (!integrationDatabaseUrl) {
    return { describeIntegration: describe.skip as typeof describe, integrationDatabaseUrl: "" };
  }
  if (!(await canReach(integrationDatabaseUrl))) {
    throw new Error(
      `INTEGRATION_DATABASE_URL is set but the database is unreachable (host: ${new URL(integrationDatabaseUrl).host}); refusing to silently skip integration coverage`,
    );
  }
  return { describeIntegration: describe, integrationDatabaseUrl };
};
