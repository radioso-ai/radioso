import { describe, expect, it, vi } from "vitest";

import { recordNotificationSuppression } from "../../../src/modules/operatorNotifications/providerSuppression.js";

const record = (emailKind: string | null, status: { type: string; bounce?: { type: string } | null }) => {
  const suppress = vi.fn(async () => undefined);
  return recordNotificationSuppression({
    event: { providerEventId: "evt-1", recipients: ["owner@example.com"], emailKind, status },
    provider: "resend",
    store: { suppress },
    logger: { info: vi.fn(), error: vi.fn() },
  }).then(() => suppress);
};

describe("recordNotificationSuppression", () => {
  it.each(["contact_notification", "operator_notice", "recipient_confirmation", "notification_alert"])(
    "records a permanent bounce and a complaint about %s mail",
    async (kind) => {
      expect(await record(kind, { type: "bounced", bounce: { type: "Permanent" } })).toHaveBeenCalledWith(
        expect.objectContaining({ email: "owner@example.com", reason: "hard_bounce" }),
      );
      expect(await record(kind, { type: "complained" })).toHaveBeenCalledWith(
        expect.objectContaining({ email: "owner@example.com", reason: "complaint" }),
      );
    },
  );

  it("leaves mail that is not a notification alone", async () => {
    expect(await record("password_reset", { type: "bounced", bounce: { type: "Permanent" } })).not.toHaveBeenCalled();
    expect(await record(null, { type: "complained" })).not.toHaveBeenCalled();
  });
});
