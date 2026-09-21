import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MIGRATION_ADVISORY_LOCK_KEY,
  runMigrations,
} from "../../src/db/runMigrations.js";
import { Database } from "../../src/shared/infra/database.js";
import { createLogger } from "../../src/shared/observability/logger.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canCreateIsolatedDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) return false;
  const database = new Database(databaseUrl);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const isolatedDatabaseUrl = (baseUrl: string, databaseName: string): string => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

const migrationsDirectory = new URL("../../src/db/migrations/", import.meta.url);
const migrationFileCount = async (): Promise<number> =>
  (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).length;

const hasReachableDatabase = await canCreateIsolatedDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableDatabase ? describe : describe.skip;

// Silent: these tests apply the full real migration set against a throwaway database and
// assert on final state, not log lines.
const silentLogger = createLogger("silent");

describeIfDatabase("runMigrations session-level advisory lock", () => {
  const isolatedName = `mig_lock_concurrency_${randomUUID().replace(/-/g, "")}`;
  let admin: Database;
  let isolatedUrl: string;

  beforeAll(async () => {
    admin = new Database(integrationDatabaseUrl!);
    await admin.execute(`CREATE DATABASE "${isolatedName}"`);
    isolatedUrl = isolatedDatabaseUrl(integrationDatabaseUrl!, isolatedName);
  });

  afterAll(async () => {
    if (admin) {
      await admin.execute(`DROP DATABASE IF EXISTS "${isolatedName}"`);
      await admin.close().catch(() => undefined);
    }
  });

  it(
    "lets two concurrent instances apply the same migration set exactly once each",
    async () => {
      // A generous lock budget keeps this test about serialisation, not about how long the
      // full migration set takes on a slow CI runner; the timeout path has its own test below.
      const generousLockBudget = { lockTimeoutMs: 120_000 };
      const [firstResult, secondResult] = await Promise.allSettled([
        runMigrations(isolatedUrl, silentLogger, generousLockBudget),
        runMigrations(isolatedUrl, silentLogger, generousLockBudget),
      ]);

      expect(firstResult.status).toBe("fulfilled");
      expect(secondResult.status).toBe("fulfilled");

      const verificationDatabase = new Database(isolatedUrl);
      try {
        const expectedCount = await migrationFileCount();
        const rows = await verificationDatabase.query<{ filename: string }>(
          "SELECT filename FROM public.schema_migrations",
        );

        expect(rows).toHaveLength(expectedCount);

        const filenames = rows.map((row) => row.filename);
        expect(new Set(filenames).size).toBe(filenames.length);
      } finally {
        await verificationDatabase.close();
      }
    },
    120_000,
  );

  it(
    "times out with a named error when another session holds the lock, then succeeds once released",
    async () => {
      // Advisory locks are scoped per database, so the holder must connect to the same
      // isolated database `runMigrations` targets below — a lock held on a different
      // database (e.g. the shared INTEGRATION_DATABASE_URL) would never conflict.
      const lockHolder = new Database(isolatedUrl);
      const lockClient = await lockHolder.pool.connect();

      try {
        await lockClient.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_ADVISORY_LOCK_KEY]);

        await expect(
          runMigrations(isolatedUrl, silentLogger, { lockTimeoutMs: 500 }),
        ).rejects.toMatchObject({
          message: "Timed out waiting for the database migration lock held by another instance (DB_MIGRATION_LOCK_TIMEOUT_MS)",
        });
      } finally {
        await lockClient.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_ADVISORY_LOCK_KEY]);
        lockClient.release();
        await lockHolder.close();
      }

      await expect(runMigrations(isolatedUrl, silentLogger)).resolves.toBeUndefined();

      const verificationDatabase = new Database(isolatedUrl);
      try {
        const expectedCount = await migrationFileCount();
        const rows = await verificationDatabase.query<{ filename: string }>(
          "SELECT filename FROM public.schema_migrations",
        );
        expect(rows).toHaveLength(expectedCount);
      } finally {
        await verificationDatabase.close();
      }
    },
    120_000,
  );
});
