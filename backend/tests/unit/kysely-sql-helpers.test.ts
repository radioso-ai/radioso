import { Kysely, PostgresDialect, sql } from "kysely";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { DB } from "../../src/shared/infra/kysely/schema.js";
import { anyOf, setLocal } from "../../src/shared/infra/kysely/sqlHelpers.js";

// Compilation is synchronous and never touches the pool, so a Kysely bound to a dummy pool
// is enough to assert the SQL each helper emits.
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: {} as Pool }) });

describe("kysely sqlHelpers", () => {
  it("setLocal emits a transaction-scoped SET LOCAL with no parameters", () => {
    const compiled = setLocal("statement_timeout", "0").compile(db);

    expect(compiled.sql).toBe("set local statement_timeout = 0");
    expect(compiled.parameters).toEqual([]);
  });

  it("anyOf emits a parameterized = ANY(...) with the array type cast", () => {
    const ids = ["a", "b"];
    const compiled = db
      .selectFrom("sessions")
      .select("id")
      .where(anyOf(sql.ref("user_id"), ids, "uuid[]"))
      .compile();

    expect(compiled.sql).toContain('= any($1::uuid[])');
    expect(compiled.parameters).toEqual([ids]);
  });
});
