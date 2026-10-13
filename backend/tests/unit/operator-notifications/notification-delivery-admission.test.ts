import { describe, expect, it, vi } from "vitest";

import {
  NotificationDeliveryAdmissionService,
  type NotificationDeliveryOutcomeRepositoryPort,
} from "../../../src/modules/operatorNotifications/public.js";
import { NoopUsageLimitPolicy } from "../../../src/shared/domain/usageLimitPolicy.js";

describe("NotificationDeliveryAdmissionService", () => {
  it("records a safe audit event when a cap skips delivery", async () => {
    const reserve = vi.fn<NotificationDeliveryOutcomeRepositoryPort["reserve"]>().mockResolvedValue({
      dispatchAllowed: true,
      emailAllowed: false,
      reason: "workspace_daily_email_cap",
      newlyRecorded: true,
    });
    const record = vi.fn().mockResolvedValue(undefined);
    const service = new NotificationDeliveryAdmissionService(
      { reserve },
      new NoopUsageLimitPolicy(),
      { record },
      undefined,
      () => new Date("2026-10-11T12:00:00.000Z"),
    );

    await expect(service.admit({
      requestId: "request-1",
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      recipientEmails: ["recipient@example.com", "second@example.com", "third@example.com"],
      requestedEmailCount: 3,
    })).resolves.toEqual({
      dispatchAllowed: true,
      emailAllowed: false,
      reason: "workspace_daily_email_cap",
    });

    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({
      usageDate: new Date("2026-10-11T00:00:00.000Z"),
      dailyEmailLimit: 100,
      conversationDispatchLimit: 5,
    }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "operator_notification.delivery_skipped",
      metadata: expect.objectContaining({ reason: "workspace_daily_email_cap", requestedEmailCount: 3 }),
    }));
    expect(JSON.stringify(record.mock.calls)).not.toContain("@");
  });

  it("tells the operator how much of today's notice email allowance is used and whether the cap stopped a send", async () => {
    const readDailyUsage = vi.fn<NotificationDeliveryOutcomeRepositoryPort["readDailyUsage"]>()
      .mockResolvedValueOnce({ reservedEmails: 40, cappedRequests: 0 })
      .mockResolvedValueOnce({ reservedEmails: 99, cappedRequests: 2 });
    const service = new NotificationDeliveryAdmissionService(
      { reserve: vi.fn(), readDailyUsage },
      new NoopUsageLimitPolicy(),
      undefined,
      undefined,
      () => new Date("2026-10-11T12:00:00.000Z"),
    );

    await expect(service.describeDailyEmailAllowance({ workspaceId: "workspace-1" }))
      .resolves.toEqual({ limit: 100, sentToday: 40, reachedToday: false });
    await expect(service.describeDailyEmailAllowance({ workspaceId: "workspace-1" }))
      .resolves.toEqual({ limit: 100, sentToday: 99, reachedToday: true });
    expect(readDailyUsage).toHaveBeenCalledWith({ workspaceId: "workspace-1", usageDate: new Date("2026-10-11T00:00:00.000Z") });
  });

  it("fails closed without workspace and conversation context", async () => {
    const reserve = vi.fn<NotificationDeliveryOutcomeRepositoryPort["reserve"]>();
    const service = new NotificationDeliveryAdmissionService({ reserve }, new NoopUsageLimitPolicy());

    await expect(service.admit({
      requestId: "request-1",
      workspaceId: null,
      accountId: null,
      conversationId: null,
      recipientEmails: ["recipient@example.com"],
      requestedEmailCount: 1,
    })).resolves.toEqual({ dispatchAllowed: false, emailAllowed: false, reason: "missing_context" });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("does not duplicate the audit event when replaying a recorded cap outcome", async () => {
    const reserve = vi.fn<NotificationDeliveryOutcomeRepositoryPort["reserve"]>().mockResolvedValue({
      dispatchAllowed: false,
      emailAllowed: false,
      reason: "conversation_dispatch_cap",
      newlyRecorded: false,
    });
    const record = vi.fn().mockResolvedValue(undefined);
    const service = new NotificationDeliveryAdmissionService(
      { reserve },
      new NoopUsageLimitPolicy(),
      { record },
    );

    await service.admit({
      requestId: "request-1",
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      recipientEmails: ["recipient@example.com"],
      requestedEmailCount: 1,
    });

    expect(record).not.toHaveBeenCalled();
  });

  it("binds a replay admission to the recipient set resolved for that attempt", async () => {
    const reserve = vi.fn<NotificationDeliveryOutcomeRepositoryPort["reserve"]>().mockResolvedValue({
      dispatchAllowed: true,
      emailAllowed: true,
      reason: null,
      newlyRecorded: true,
    });
    const service = new NotificationDeliveryAdmissionService({ reserve }, new NoopUsageLimitPolicy());
    const admission = {
      requestId: "request-1",
      workspaceId: "workspace-1",
      accountId: "account-1",
      conversationId: "conversation-1",
      requestedEmailCount: 1,
    };

    await service.admit({ ...admission, recipientEmails: ["before@example.com"] });
    await service.admit({ ...admission, recipientEmails: ["after@example.com"] });

    const [first, retry] = reserve.mock.calls.map(([input]) => input);
    expect(first.recipientDigest).not.toBe(retry.recipientDigest);
    expect(first.recipientDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(reserve.mock.calls)).not.toContain("@example.com");
  });
});
