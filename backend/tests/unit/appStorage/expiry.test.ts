import { describe, expect, it } from "vitest";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import { isExpired, resolveExpiresAt } from "../../../src/modules/appStorage/public.js";

describe("resolveExpiresAt", () => {
  const now = new Date("2026-09-07T10:00:00.000Z");

  it("leaves a record without a deadline when the collection retains everything", () => {
    expect(resolveExpiresAt(buildStorageCollection(), now)).toBeNull();
  });

  it("sets the deadline the collection's ttl declares, measured from the write", () => {
    const collection = buildStorageCollection({ retention: { kind: "ttl", seconds: 3600 } });
    expect(resolveExpiresAt(collection, now)).toEqual(new Date("2026-09-07T11:00:00.000Z"));
  });
});

describe("isExpired", () => {
  const now = new Date("2026-09-07T10:00:00.000Z");

  it("treats a record with no deadline as live", () => {
    expect(isExpired(null, now)).toBe(false);
  });

  it("treats a deadline in the future as live and one already reached as expired", () => {
    expect(isExpired(new Date("2026-09-07T10:00:01.000Z"), now)).toBe(false);
    expect(isExpired(new Date("2026-09-07T10:00:00.000Z"), now)).toBe(true);
    expect(isExpired(new Date("2026-09-07T09:59:59.000Z"), now)).toBe(true);
  });
});
