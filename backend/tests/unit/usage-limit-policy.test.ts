import { describe, expect, it } from "vitest";

import { NoopUsageLimitPolicy } from "../../src/shared/domain/usageLimitPolicy.js";

describe("NoopUsageLimitPolicy", () => {
  it("returns a noop reservation for indexed storage requests", async () => {
    const policy = new NoopUsageLimitPolicy();

    const reservation = await policy.reserveIndexedStorage({
      workspaceId: "workspace-1",
      contentSizeBytes: 4096,
      sourceKind: "inline_text",
    });

    await expect(reservation.commit()).resolves.toBeUndefined();
    await expect(reservation.release()).resolves.toBeUndefined();
  });

  it("tolerates a zero or missing byte size on indexed storage reservations", async () => {
    const policy = new NoopUsageLimitPolicy();

    const reservation = await policy.reserveIndexedStorage({
      workspaceId: "workspace-1",
      contentSizeBytes: 0,
    });

    await expect(reservation.commit()).resolves.toBeUndefined();
  });
});
