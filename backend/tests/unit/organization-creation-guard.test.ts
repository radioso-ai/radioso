import { describe, expect, it, vi } from "vitest";

import { noopOrganizationCreationGuard } from "../../src/shared/domain/organizationCreationGuard.js";
import { OssOrganizationCreationGuard } from "../../src/modules/auth/composition.js";

describe("noopOrganizationCreationGuard", () => {
  it("allows organization creation and returns an inert reservation", async () => {
    const reservation = await noopOrganizationCreationGuard.reserve({ intent: "additional", userId: "user-1" });

    await expect(reservation.commit({ accountId: "account-1" })).resolves.toBeUndefined();
    await expect(reservation.release()).resolves.toBeUndefined();
  });

  it("uses the same no-op lifecycle for repeated reservations", async () => {
    const releaseSpy = vi.fn();

    const first = await noopOrganizationCreationGuard.reserve({ intent: "additional", userId: "user-1" });
    const second = await noopOrganizationCreationGuard.reserve({ intent: "signup" });
    await first.release();
    releaseSpy();
    await second.commit({ accountId: "account-2" });

    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps signup available for replaceable Enterprise-style policies", async () => {
    await expect(noopOrganizationCreationGuard.isSignupAvailable()).resolves.toBe(true);
  });
});

describe("OssOrganizationCreationGuard", () => {
  it("delegates signup availability and core provisioning to the database bootstrap", async () => {
    const bootstrap = {
      provision: vi.fn(async () => ({
        account: { id: "account-1", name: "OSS" },
        userId: "account-1",
        workspace: { id: "workspace-1", name: "Default", publicRouteKey: "1234567890" },
      })),
      isAvailable: vi.fn(async () => true),
    };
    const guard = new OssOrganizationCreationGuard(bootstrap);

    await expect(guard.isSignupAvailable()).resolves.toBe(true);
    const reservation = await guard.reserve({ intent: "signup" });
    await reservation.coreProvisioner?.provision({
      intent: "new_user",
      organizationName: "OSS",
      email: "owner@example.com",
      passwordHash: "hash",
      emailVerifiedAt: null,
    });
    await reservation.commit({ accountId: "account-1" });

    expect(bootstrap.provision).toHaveBeenCalledTimes(1);
  });

  it("rejects closed signup and every additional organization request", async () => {
    const bootstrap = {
      provision: vi.fn(async () => {
        throw Object.assign(new Error("Registration is closed"), { statusCode: 403, code: "forbidden" });
      }),
      isAvailable: vi.fn(async () => false),
    };
    const guard = new OssOrganizationCreationGuard(bootstrap);

    const signup = await guard.reserve({ intent: "signup" });
    await expect(signup.coreProvisioner?.provision({
      intent: "new_user",
      organizationName: "OSS",
      email: "owner@example.com",
      passwordHash: "hash",
      emailVerifiedAt: null,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: "forbidden",
    });
    await expect(guard.reserve({ intent: "additional", userId: "user-1" })).rejects.toMatchObject({
      statusCode: 403,
      code: "forbidden",
    });
  });
});
