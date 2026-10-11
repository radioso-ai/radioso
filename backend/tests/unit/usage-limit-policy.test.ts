import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTIFICATION_EMAIL_DAILY_LIMIT,
  NoopUsageLimitPolicy,
  resolveNotificationEmailDailyLimit,
} from "../../src/shared/domain/usageLimitPolicy.js";

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

  it("resolves a finite self-hosted notification email allowance through the policy", async () => {
    const policy = new NoopUsageLimitPolicy();

    await expect(resolveNotificationEmailDailyLimit(policy, {
      workspaceId: "workspace-1",
    })).resolves.toBe(DEFAULT_NOTIFICATION_EMAIL_DAILY_LIMIT);
    expect(DEFAULT_NOTIFICATION_EMAIL_DAILY_LIMIT).toBe(100);
  });

  it("falls back safely when an older optional policy does not resolve notification limits", async () => {
    await expect(resolveNotificationEmailDailyLimit({}, {
      workspaceId: "workspace-1",
    })).resolves.toBe(DEFAULT_NOTIFICATION_EMAIL_DAILY_LIMIT);
  });
});
