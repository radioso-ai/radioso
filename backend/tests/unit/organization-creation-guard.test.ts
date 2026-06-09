import { describe, expect, it, vi } from "vitest";

import { NoopOrganizationCreationGuard } from "../../src/shared/domain/organizationCreationGuard.js";

describe("NoopOrganizationCreationGuard", () => {
  it("allows organization creation and returns an inert reservation", async () => {
    const guard = new NoopOrganizationCreationGuard();

    const reservation = await guard.reserve({ userId: "user-1" });

    await expect(reservation.commit()).resolves.toBeUndefined();
    await expect(reservation.release()).resolves.toBeUndefined();
  });

  it("uses the same no-op lifecycle for repeated reservations", async () => {
    const guard = new NoopOrganizationCreationGuard();
    const releaseSpy = vi.fn();

    const first = await guard.reserve({ userId: "user-1" });
    const second = await guard.reserve({ userId: "user-1" });
    await first.release();
    releaseSpy();
    await second.commit();

    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });
});
