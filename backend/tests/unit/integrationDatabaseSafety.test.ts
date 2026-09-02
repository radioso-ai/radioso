import { describe, expect, it, vi } from "vitest";

import {
  INTEGRATION_DATABASE_MARKER,
  assertIntegrationDatabaseIdentityIsSafe,
  assertIntegrationDatabaseUrlIsSafe,
  assertMarkedIntegrationDatabase,
  requireIntegrationDatabaseUrl,
  shouldGuardIntegrationTests,
} from "../support/integrationDatabaseSafety.js";

describe("integration database safety", () => {
  it("rejects the application database even when localhost uses a loopback alias", () => {
    expect(() => assertIntegrationDatabaseUrlIsSafe({
      applicationDatabaseUrl: "postgres://app:secret@localhost:5432/radioso_test",
      integrationDatabaseUrl: "postgres://tests:secret@127.0.0.1:5432/radioso_test",
    })).toThrow(/same PostgreSQL database/i);
  });

  it("requires a database name ending in _test", () => {
    expect(() => assertIntegrationDatabaseUrlIsSafe({
      applicationDatabaseUrl: "postgres://app:secret@localhost:5432/radioso",
      integrationDatabaseUrl: "postgres://tests:secret@localhost:5433/radioso",
    })).toThrow(/must end in _test/i);
  });

  it("rejects connection query parameters that can override the inspected target", () => {
    expect(() => assertIntegrationDatabaseUrlIsSafe({
      applicationDatabaseUrl: "postgres://app:secret@localhost:5432/radioso_test",
      integrationDatabaseUrl: "postgres://tests:secret@localhost:5433/radioso_test?host=localhost&port=5432",
    })).toThrow(/target override.*host/i);
  });

  it("requires an exact database-name acknowledgement before preparation", () => {
    expect(() => assertIntegrationDatabaseUrlIsSafe({
      integrationDatabaseUrl: "postgres://tests:secret@localhost:5433/radioso_test",
      acknowledgedDatabaseName: "some_test",
    })).toThrow(/RADIOSO_INTEGRATION_DATABASE_NAME.*radioso_test/i);

    expect(() => assertIntegrationDatabaseUrlIsSafe({
      integrationDatabaseUrl: "postgres://tests:secret@localhost:5433/radioso_test",
      acknowledgedDatabaseName: "radioso_test",
    })).not.toThrow();
  });

  it("never includes credentials in a rejected URL diagnostic", () => {
    expect(() => assertIntegrationDatabaseUrlIsSafe({
      integrationDatabaseUrl: "postgres://tests:super-secret@localhost:5433/radioso",
    })).toThrowError(expect.not.stringContaining("super-secret"));
  });

  it("rejects a reachable database without the harness marker", async () => {
    const readIdentity = vi.fn().mockResolvedValue({
      databaseName: "radioso_test",
      databaseOid: "1",
      clusterIdentifier: "cluster-a",
      marker: null,
    });

    await expect(assertMarkedIntegrationDatabase({
      integrationDatabaseUrl: "postgres://tests:secret@localhost:5433/radioso_test",
      readIdentity,
    })).rejects.toThrow(/not marked as disposable/i);
  });

  it("accepts only the exact harness marker", async () => {
    const readIdentity = vi.fn(async (databaseUrl: string) => databaseUrl.includes("app:")
      ? {
        databaseName: "radioso",
        databaseOid: "1",
        clusterIdentifier: "cluster-a",
        marker: null,
      }
      : {
        databaseName: "radioso_test",
        databaseOid: "2",
        clusterIdentifier: "cluster-a",
        marker: INTEGRATION_DATABASE_MARKER,
      });

    await expect(assertMarkedIntegrationDatabase({
      applicationDatabaseUrl: "postgres://app:secret@localhost:5432/radioso",
      integrationDatabaseUrl: "postgres://tests:secret@localhost:5433/radioso_test",
      readIdentity,
    })).resolves.toMatchObject({ databaseName: "radioso_test", marker: INTEGRATION_DATABASE_MARKER });
  });

  it("rejects distinct URL spellings that resolve to the same live PostgreSQL database", async () => {
    const readIdentity = vi.fn().mockResolvedValue({
      databaseName: "radioso_test",
      databaseOid: "2",
      clusterIdentifier: "cluster-a",
      marker: INTEGRATION_DATABASE_MARKER,
    });

    await expect(assertMarkedIntegrationDatabase({
      applicationDatabaseUrl: "postgres://app:secret@database.internal:5432/radioso_test",
      integrationDatabaseUrl: "postgres://tests:secret@database-alias.internal:5432/radioso_test",
      readIdentity,
    })).rejects.toThrow(/same PostgreSQL database/i);
    expect(readIdentity).toHaveBeenCalledTimes(2);
  });

  it("performs the live identity comparison before a database receives a marker", async () => {
    const readIdentity = vi.fn().mockResolvedValue({
      databaseName: "radioso_test",
      databaseOid: "2",
      clusterIdentifier: "cluster-a",
      marker: null,
    });

    await expect(assertIntegrationDatabaseIdentityIsSafe({
      applicationDatabaseUrl: "postgres://app:secret@database.internal:5432/radioso_test",
      integrationDatabaseUrl: "postgres://tests:secret@database-alias.internal:5432/radioso_test",
      readIdentity,
    })).rejects.toThrow(/same PostgreSQL database/i);
    expect(readIdentity).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a configured application database cannot be identified", async () => {
    const readIdentity = vi.fn(async (databaseUrl: string) => {
      if (databaseUrl.includes("app.internal")) {
        throw new Error("permission denied");
      }
      return {
        databaseName: "radioso_test",
        databaseOid: "2",
        clusterIdentifier: "cluster-a",
        marker: INTEGRATION_DATABASE_MARKER,
      };
    });

    await expect(assertMarkedIntegrationDatabase({
      applicationDatabaseUrl: "postgres://app:secret@app.internal:5432/radioso",
      integrationDatabaseUrl: "postgres://tests:secret@tests.internal:5432/radioso_test",
      readIdentity,
    })).rejects.toThrow(/Unable to verify application database/i);
  });

  it("guards full and integration runs but leaves focused unit and contract runs alone", () => {
    expect(shouldGuardIntegrationTests(["vitest", "run"])).toBe(true);
    expect(shouldGuardIntegrationTests(["vitest", "run", "tests/integration/message.test.ts"])).toBe(true);
    expect(shouldGuardIntegrationTests(["vitest", "run", "src/usageLimitService.integration.test.ts"])).toBe(true);
    expect(shouldGuardIntegrationTests(["vitest", "run", "tests/unit"])).toBe(false);
    expect(shouldGuardIntegrationTests(["vitest", "run", "tests/contract"])).toBe(false);
    expect(shouldGuardIntegrationTests(["vitest", "run", "src/accessPolicy.test.ts"])).toBe(false);
  });

  it("fails an integration lane instead of silently skipping when no database is configured", () => {
    expect(() => requireIntegrationDatabaseUrl(undefined)).toThrow(/required.*skipped database coverage/i);
    expect(requireIntegrationDatabaseUrl("postgres://tests:secret@localhost:5433/radioso_test"))
      .toBe("postgres://tests:secret@localhost:5433/radioso_test");
  });
});
