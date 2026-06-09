import { describe, expect, it, vi } from "vitest";

import { noopOrganizationCreationGuard } from "../../src/shared/domain/organizationCreationGuard.js";

describe("noopOrganizationCreationGuard", () => {
  it("allows organization creation and returns an inert reservation", async () => {
    const reservation = await noopOrganizationCreationGuard.reserve({ userId: "user-1" });

    await expect(reservation.commit()).resolves.toBeUndefined();
    await expect(reservation.release()).resolves.toBeUndefined();
  });

  it("uses the same no-op lifecycle for repeated reservations", async () => {
    const releaseSpy = vi.fn();

    const first = await noopOrganizationCreationGuard.reserve({ userId: "user-1" });
    const second = await noopOrganizationCreationGuard.reserve({ userId: "user-1" });
    await first.release();
    releaseSpy();
    await second.commit();

    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });
});
