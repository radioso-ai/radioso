import { Kysely, PostgresDialect, sql } from "kysely";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { DB } from "../../src/shared/infra/kysely/schema.js";
import { anyOf, castText, clockTimestamp, jsonbConcat, jsonbKeyText, jsonbSet, optionalTimestampMatch, setLocal, timestampMatchOrAbsent, toJsonb, toSanitizedJsonb, transactionAdvisoryLock } from "../../src/shared/infra/kysely/sqlHelpers.js";

// Compilation is synchronous and never touches the pool, so a Kysely bound to a dummy pool
// is enough to assert the SQL each helper emits.
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: {} as Pool }) });

describe("kysely sqlHelpers", () => {
  it("setLocal emits a transaction-scoped SET LOCAL with no parameters", () => {
    const compiled = setLocal("statement_timeout", "0").compile(db);

    expect(compiled.sql).toBe("set local statement_timeout = 0");
    expect(compiled.parameters).toEqual([]);
  });

  it("transactionAdvisoryLock emits a parameterized text-key transaction lock", () => {
    const compiled = transactionAdvisoryLock("slack_conversation:workspace:key").compile(db);

    expect(compiled.sql).toBe("select pg_advisory_xact_lock(hashtextextended($1, 0))");
    expect(compiled.parameters).toEqual(["slack_conversation:workspace:key"]);
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

  it("optionalTimestampMatch skips the check (always true) when expected is undefined or null", () => {
    const undefinedCompiled = db
      .selectFrom("agent_skills")
      .select("id")
      .where((eb) => optionalTimestampMatch(eb.ref("updated_at"), undefined))
      .compile();
    expect(undefinedCompiled.sql).toContain("IS NULL OR date_trunc('milliseconds'");
    expect(undefinedCompiled.parameters[0]).toBeNull();

    const nullCompiled = db
      .selectFrom("agent_skills")
      .select("id")
      .where((eb) => optionalTimestampMatch(eb.ref("updated_at"), null))
      .compile();
    expect(nullCompiled.parameters[0]).toBeNull();
  });

  it("optionalTimestampMatch requires a millisecond-truncated match when expected is a Date", () => {
    const expected = new Date("2026-01-01T00:00:00.123Z");
    const compiled = db
      .updateTable("agent_skills")
      .set({ enabled: true })
      .where((eb) => optionalTimestampMatch(eb.ref("updated_at"), expected))
      .compile();

    expect(compiled.sql).toContain("date_trunc('milliseconds', \"updated_at\") = date_trunc('milliseconds'");
    expect(compiled.parameters).toContain(expected);
  });

  it("timestampMatchOrAbsent emits an always-false guard when expected is null", () => {
    const compiled = db
      .insertInto("agent_context_variables")
      .values({
        id: "00000000-0000-0000-0000-000000000000",
        agent_id: "00000000-0000-0000-0000-000000000001",
        variable_id: "00000000-0000-0000-0000-000000000002",
        source: "pushed",
        surfacing: "always",
      })
      .onConflict((oc) =>
        oc.columns(["agent_id", "variable_id"]).doUpdateSet({ enabled: true }).where((eb) => timestampMatchOrAbsent(eb.ref("updated_at"), null)),
      )
      .compile();

    expect(compiled.sql).toContain("where false");
  });

  it("timestampMatchOrAbsent emits a millisecond-truncated match when expected is a Date", () => {
    const expected = new Date("2026-01-01T00:00:00.456Z");
    const compiled = db
      .insertInto("agent_context_variables")
      .values({
        id: "00000000-0000-0000-0000-000000000000",
        agent_id: "00000000-0000-0000-0000-000000000001",
        variable_id: "00000000-0000-0000-0000-000000000002",
        source: "pushed",
        surfacing: "always",
      })
      .onConflict((oc) =>
        oc.columns(["agent_id", "variable_id"]).doUpdateSet({ enabled: true }).where((eb) => timestampMatchOrAbsent(eb.ref("updated_at"), expected)),
      )
      .compile();

    expect(compiled.sql).toContain("date_trunc('milliseconds', \"updated_at\") = date_trunc('milliseconds'");
    expect(compiled.parameters).toContain(expected);
  });
});
