import { describe, expect, it } from "vitest";

import { encodeTailCursor } from "../../src/db/repositories/messageRepository.js";
import { decodeCursorWithKeys } from "../../src/shared/domain/cursorPagination.js";

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
