import { beforeEach, describe, expect, it } from "vitest";

import {
  EnterpriseOrganizationCreationGuard,
  resolveOrganizationCreationDefaultLimit,
} from "./organizationCreationGuard.js";

// The guard's data-access behavior (atomic increment boundary, limit error,
// unlimited override, release decrement, override CRUD) is exercised against a
// real Postgres in `organizationCreationGuard.integration.test.ts`. After the
// Kysely migration the guard builds its own Kysely from `database.pool` rather
// than issuing the literal SQL strings these unit tests used to assert, so the
// former SQL-string scripted-mock cases were replaced by that characterization
// suite. Only the pure, DB-free env resolution stays here.
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

describe("EnterpriseOrganizationCreationGuard signup", () => {
  it("keeps registration available and does not consult the additional-organization counter", async () => {
    const guard = new EnterpriseOrganizationCreationGuard({ pool: {} as never });

    await expect(guard.isSignupAvailable()).resolves.toBe(true);
    const reservation = await guard.reserve({ intent: "signup" });
    await expect(reservation.commit({ accountId: "account-1" })).resolves.toBeUndefined();
  });
});
