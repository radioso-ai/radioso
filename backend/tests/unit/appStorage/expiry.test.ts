import { describe, expect, it } from "vitest";

import { buildStorageCollection } from "../../support/appStorageCollections.js";
import { resolveTtlSeconds } from "../../../src/modules/appStorage/public.js";

describe("resolveTtlSeconds", () => {
  it("gives no interval when the collection retains everything", () => {
    expect(resolveTtlSeconds(buildStorageCollection())).toBeNull();
  });

  it("gives the interval the collection declares, leaving the deadline to the write", () => {
    // The deadline is settled in SQL by the transaction that stores the row: a
    // timestamp read here is read before the write queues for a lock, and a write
    // that waited would renew a record whose deadline passed while it waited.
    const collection = buildStorageCollection({ retention: { kind: "ttl", seconds: 3600 } });
    expect(resolveTtlSeconds(collection)).toBe(3600);
  });
});
