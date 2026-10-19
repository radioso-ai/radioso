import { Kysely, PostgresDialect } from "kysely";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { encodeTailCursor, preciseTimestamptz } from "../../src/db/repositories/messageRepository.js";
import { CursorPaginationError, decodeCursorWithKeys } from "../../src/shared/domain/cursorPagination.js";
import type { DB } from "../../src/shared/infra/kysely/schema.js";

// Compilation is synchronous and never touches the pool, so a Kysely bound to a dummy pool is
// enough to assert the SQL `preciseTimestamptz` emits (mirrors tests/unit/kysely-sql-helpers.test.ts).
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: {} as Pool }) });

// #1518: the tail cursor must round-trip the stored microsecond precision rather than the
// millisecond precision a JS `Date` read of `created_at` would round it to. These are pure-JS
// checks of the one place the repository builds a tail cursor; the integration suite
// (message-repository-tail.test.ts) proves the same thing end-to-end against Postgres.
describe("encodeTailCursor", () => {
  it("carries the row's precise createdAt text and id, with no markedAt when none is given", () => {
    const cursor = encodeTailCursor({ created_at_precise: "2026-06-01T00:00:01.123456Z", id: "msg-1" });

    expect(decodeCursorWithKeys(cursor, ["createdAt", "id"]).keys).toEqual({
      createdAt: "2026-06-01T00:00:01.123456Z",
      id: "msg-1",
    });
  });

  it("adds the markedAt watermark only when given one", () => {
    const cursor = encodeTailCursor(
      { created_at_precise: "2026-06-01T00:00:01.123456Z", id: "msg-1" },
      "2026-06-01T00:00:02.000Z",
    );

    expect(decodeCursorWithKeys(cursor, ["createdAt", "id"]).keys).toEqual({
      createdAt: "2026-06-01T00:00:01.123456Z",
      id: "msg-1",
      markedAt: "2026-06-01T00:00:02.000Z",
    });
  });

  it("round-trips microsecond precision a JS Date would round away", () => {
    const precise = "2026-06-01T00:00:01.123456Z";
    const cursor = encodeTailCursor({ created_at_precise: precise, id: "msg-1" });

    const decoded = decodeCursorWithKeys(cursor, ["createdAt", "id"]).keys.createdAt;

    expect(decoded).toBe(precise);
    expect(decoded).not.toBe(new Date(precise).toISOString());
  });

  it("gives two messages in the same millisecond distinct cursors", () => {
    const earlier = encodeTailCursor({ created_at_precise: "2026-06-01T00:00:01.100001Z", id: "msg-1" });
    const later = encodeTailCursor({ created_at_precise: "2026-06-01T00:00:01.100002Z", id: "msg-2" });

    expect(earlier).not.toBe(later);
  });
});

// #1518 follow-up: this text now reaches Postgres directly (never through a JS `Date`), so a
// caller-supplied cursor must be format-checked before it ever reaches a cast.
describe("preciseTimestamptz", () => {
  it("compiles a full-precision instant to a parameterized timestamptz cast", () => {
    const compiled = preciseTimestamptz("2026-06-01T00:00:01.123456Z").compile(db);

    expect(compiled.sql).toBe("$1::timestamptz");
    expect(compiled.parameters).toEqual(["2026-06-01T00:00:01.123456Z"]);
  });

  it("accepts a legacy millisecond-precision cursor text", () => {
    expect(() => preciseTimestamptz("2026-06-01T00:00:01.000Z")).not.toThrow();
  });

  it("rejects a malformed cursor value as a CursorPaginationError instead of letting it reach Postgres", () => {
    expect(() => preciseTimestamptz("not-a-timestamp")).toThrow(CursorPaginationError);
    expect(() => preciseTimestamptz("2026-06-01 00:00:01")).toThrow(CursorPaginationError);
    expect(() => preciseTimestamptz("2026-06-01T00:00:01.123456")).toThrow(CursorPaginationError); // missing Z
    expect(() => preciseTimestamptz("2026-06-01T00:00:01.123456Z; DROP TABLE messages;")).toThrow(CursorPaginationError);
  });
});
