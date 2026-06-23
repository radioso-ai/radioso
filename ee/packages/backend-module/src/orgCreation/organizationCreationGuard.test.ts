import { beforeEach, describe, expect, it } from "vitest";

import { resolveOrganizationCreationDefaultLimit } from "./organizationCreationGuard.js";

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
