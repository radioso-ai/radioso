import { describe, expect, it } from "vitest";

import { CursorPaginationError, decodeCursor, encodeCursor } from "../../src/shared/domain/cursorPagination.js";

describe("cursor pagination helpers", () => {
  it("round-trips opaque cursor payloads", () => {
    const cursor = encodeCursor({
      createdAt: "2026-04-04T00:00:00.000Z",
      id: "abc-123",
    });

    expect(cursor).not.toContain("{");
    expect(decodeCursor(cursor)).toEqual({
      version: 1,
      keys: {
        createdAt: "2026-04-04T00:00:00.000Z",
        id: "abc-123",
      },
    });
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrowError(CursorPaginationError);
    expect(() => decodeCursor("not-a-cursor")).toThrow("Invalid cursor");
  });

  it("rejects unsupported cursor versions", () => {
    const unsupported = Buffer.from(
      JSON.stringify({
        version: 2,
        keys: { id: "abc-123" },
      }),
      "utf8",
    ).toString("base64url");

    expect(() => decodeCursor(unsupported)).toThrowError(CursorPaginationError);
    expect(() => decodeCursor(unsupported)).toThrow("Unsupported cursor version");
  });

  it("rejects cursor payloads without string key pairs", () => {
    const invalidKeys = Buffer.from(
      JSON.stringify({
        version: 1,
        keys: { id: 123 },
      }),
      "utf8",
    ).toString("base64url");

    expect(() => decodeCursor(invalidKeys)).toThrowError(CursorPaginationError);
    expect(() => decodeCursor(invalidKeys)).toThrow("Cursor keys must be string pairs");
  });
});
