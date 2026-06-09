import { beforeEach, describe, expect, it } from "vitest";

import {
  EnterpriseOrganizationCreationGuard,
  OrganizationCreationLimitExceededError,
  resolveOrganizationCreationDefaultLimit,
} from "./organizationCreationGuard.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";

class ScriptedDatabase implements UsageLimitDatabasePort {
  readonly queries: Array<{ text: string; params?: unknown[] }> = [];
  private readonly responders: Array<(text: string, params?: unknown[]) => unknown[]> = [];

  push(responder: (text: string, params?: unknown[]) => unknown[]) {
    this.responders.push(responder);
  }

  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
    this.queries.push({ text, params });
    const responder = this.responders.shift();
    return (responder ? responder(text, params) : []) as T[];
  }
}

describe("resolveOrganizationCreationDefaultLimit", () => {
  const originalValue = process.env.EE_MAX_ORGS_PER_USER_PER_MONTH;

  beforeEach(() => {
    if (originalValue === undefined) {
      delete process.env.EE_MAX_ORGS_PER_USER_PER_MONTH;
    } else {
      process.env.EE_MAX_ORGS_PER_USER_PER_MONTH = originalValue;
    }
  });

  it("defaults to 10 when EE_MAX_ORGS_PER_USER_PER_MONTH is unset or invalid", () => {
    delete process.env.EE_MAX_ORGS_PER_USER_PER_MONTH;
    expect(resolveOrganizationCreationDefaultLimit()).toBe(10);

    process.env.EE_MAX_ORGS_PER_USER_PER_MONTH = "not-a-number";
    expect(resolveOrganizationCreationDefaultLimit()).toBe(10);
  });

  it("uses a non-negative integer env override", () => {
    process.env.EE_MAX_ORGS_PER_USER_PER_MONTH = "25";

    expect(resolveOrganizationCreationDefaultLimit()).toBe(25);
  });
});

describe("EnterpriseOrganizationCreationGuard", () => {
  it("increments with an atomic used_count boundary check", async () => {
    const database = new ScriptedDatabase();
    database.push(() => []);
    database.push(() => []);
    database.push((_text, params) => [{ used_count: 1, period_start: params?.[1] }]);
    const guard = new EnterpriseOrganizationCreationGuard(database, { defaultLimit: 1 });

    const reservation = await guard.reserve({ userId: "00000000-0000-0000-0000-000000000001" });
    await reservation.commit();

    const update = database.queries.find((query) => query.text.includes("UPDATE ee_org_creation_counters"));
    expect(update?.text).toContain("used_count < $3");
    expect(update?.text).toContain("RETURNING used_count");
    expect(update?.params?.[2]).toBe(1);
  });

  it("throws a limit error with details when the atomic update cannot increment", async () => {
    const database = new ScriptedDatabase();
    database.push(() => []);
    database.push(() => []);
    database.push(() => []);
    database.push(() => [{ used_count: 1 }]);
    const guard = new EnterpriseOrganizationCreationGuard(database, { defaultLimit: 1, now: () => new Date("2026-06-09T12:00:00.000Z") });

    await expect(guard.reserve({ userId: "00000000-0000-0000-0000-000000000001" })).rejects.toMatchObject({
      details: {
        limit: 1,
        used: 1,
        periodStart: "2026-06-01",
        resetAt: "2026-07-01T00:00:00.000Z",
      },
    });
  });

  it("does not increment counters when an unlimited override is present", async () => {
    const database = new ScriptedDatabase();
    database.push(() => [{ monthly_limit: null, updated_at: new Date("2026-06-09T00:00:00.000Z") }]);
    const guard = new EnterpriseOrganizationCreationGuard(database, { defaultLimit: 1 });

    await guard.reserve({ userId: "00000000-0000-0000-0000-000000000001" });

    expect(database.queries.some((query) => query.text.includes("UPDATE ee_org_creation_counters"))).toBe(false);
  });

  it("releases a successful reservation by decrementing the monthly counter", async () => {
    const database = new ScriptedDatabase();
    database.push(() => []);
    database.push(() => []);
    database.push(() => [{ used_count: 1 }]);
    database.push(() => []);
    const guard = new EnterpriseOrganizationCreationGuard(database, { defaultLimit: 2 });

    const reservation = await guard.reserve({ userId: "00000000-0000-0000-0000-000000000001" });
    await reservation.release();

    expect(database.queries.at(-1)?.text).toContain("GREATEST(used_count - 1, 0)");
  });

  it("reads, upserts, and deletes per-user overrides", async () => {
    const database = new ScriptedDatabase();
    database.push(() => [{ user_id: "00000000-0000-0000-0000-000000000001", monthly_limit: 25, updated_at: new Date("2026-06-09T00:00:00.000Z") }]);
    database.push(() => [{ user_id: "00000000-0000-0000-0000-000000000001", monthly_limit: null, updated_at: new Date("2026-06-10T00:00:00.000Z") }]);
    database.push(() => []);
    const guard = new EnterpriseOrganizationCreationGuard(database);

    await expect(guard.getOverride("00000000-0000-0000-0000-000000000001")).resolves.toMatchObject({
      userId: "00000000-0000-0000-0000-000000000001",
      monthlyLimit: 25,
      unlimited: false,
    });
    await expect(guard.upsertOverride({
      userId: "00000000-0000-0000-0000-000000000001",
      monthlyLimit: null,
    })).resolves.toMatchObject({
      monthlyLimit: null,
      unlimited: true,
    });
    await expect(guard.deleteOverride("00000000-0000-0000-0000-000000000001")).resolves.toBeUndefined();
  });
});
