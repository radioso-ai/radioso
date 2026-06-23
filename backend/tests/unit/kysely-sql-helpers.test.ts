import { Kysely, PostgresDialect, sql } from "kysely";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { DB } from "../../src/shared/infra/kysely/schema.js";
import { anyOf, castText, clockTimestamp, jsonbConcat, jsonbKeyText, jsonbSet, setLocal, toJsonb, toSanitizedJsonb } from "../../src/shared/infra/kysely/sqlHelpers.js";

// Compilation is synchronous and never touches the pool, so a Kysely bound to a dummy pool
// is enough to assert the SQL each helper emits.
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: {} as Pool }) });

describe("kysely sqlHelpers", () => {
  it("setLocal emits a transaction-scoped SET LOCAL with no parameters", () => {
    const compiled = setLocal("statement_timeout", "0").compile(db);

    expect(compiled.sql).toBe("set local statement_timeout = 0");
    expect(compiled.parameters).toEqual([]);
  });

  it("toJsonb stringifies the value and casts to jsonb (works for arrays)", () => {
    const compiled = db
      .selectFrom("sessions")
      .select(() => toJsonb([{ id: "a" }]).as("payload"))
      .compile();

    expect(compiled.sql).toContain("::jsonb");
    expect(compiled.parameters).toEqual(['[{"id":"a"}]']);
  });

  it("toSanitizedJsonb preserves the jsonb cast and replaces invalid text characters", () => {
    const compiled = db
      .selectFrom("sessions")
      .select(() => toSanitizedJsonb({ value: `bad ${String.fromCharCode(0)} text` }).as("payload"))
      .compile();

    expect(compiled.sql).toContain("::jsonb");
    expect(compiled.parameters).toEqual([`{"value":"bad ${String.fromCharCode(0xfffd)} text"}`]);
  });

  it("clockTimestamp emits clock_timestamp()", () => {
    expect(clockTimestamp().compile(db).sql).toBe("clock_timestamp()");
  });

  it("jsonbConcat emits the || merge with a jsonb-cast right operand", () => {
    const compiled = db
      .updateTable("agent_skills")
      .set({ config: jsonbConcat(sql.ref("config"), toJsonb({ a: 1 })) })
      .compile();
    expect(compiled.sql).toContain('"config" = "config" || $1::jsonb');
  });

  it("jsonbKeyText, jsonbSet, castText emit the expected fragments", () => {
    expect(jsonbKeyText(sql.ref("metadata_json"), "k").compile(db).sql).toContain('"metadata_json" ->> $1');
    expect(castText(sql.ref("id")).compile(db).sql).toBe('"id"::text');
    const setSql = jsonbSet(sql.ref("metadata_json"), ["suggestions"], toJsonb([])).compile(db).sql;
    expect(setSql).toContain("jsonb_set(coalesce(\"metadata_json\", '{}'::jsonb), '{suggestions}',");
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
