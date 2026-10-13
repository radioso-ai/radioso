import { describe, expect, it, vi } from "vitest";

import {
  NotificationRecipientPolicyService,
} from "../../../src/modules/operatorNotifications/notificationRecipientPolicy.js";

const NOW = new Date("2026-10-13T12:00:00.000Z");

type StateStore = ConstructorParameters<typeof NotificationRecipientPolicyService>[0]["states"];

const store = (states: Record<string, "confirmed" | "grandfathered" | "revoked" | "waiting_for_confirmation" | "suppressed">): StateStore => ({
  read: vi.fn(async ({ emails }) => emails.map((email) => ({
    email,
    state: states[email] ?? "waiting_for_confirmation",
    grandfatheredUntil: states[email] === "grandfathered" ? new Date("2026-10-20T00:00:00.000Z") : null,
  }))),
  ensure: vi.fn(async (_workspaceId, email) => ({ recipientId: `recipient:${email}` })),
  reserveConfirmationSend: vi.fn(async ({ email }) => states[email] !== "revoked" && states[email] !== "suppressed"
    ? { recipientId: `recipient:${email}` }
    : null),
  releaseConfirmationSend: vi.fn(async () => undefined),
  confirm: vi.fn(),
  revoke: vi.fn(),
});

describe("NotificationRecipientPolicyService", () => {
  it("delivers only confirmed and unexpired grandfathered recipients and requests confirmation without exposing addresses in outcomes", async () => {
    const states = store({
      "member@example.com": "confirmed",
      "legacy@example.com": "grandfathered",
      "bounced@example.com": "suppressed",
    });
    const sendConfirmation = vi.fn(async () => undefined);
    const service = new NotificationRecipientPolicyService({
      enabled: true,
      states,
      sendConfirmation,
      now: () => NOW,
    });

    await expect(service.prepareDelivery({
      workspaceId: "workspace-id",
      workspaceName: "Acme",
      agentName: "Concierge",
      emails: ["MEMBER@example.com ", "legacy@example.com", "waiting@example.com", "bounced@example.com"],
      idempotencyKey: "request-id",
    })).resolves.toEqual({
      eligibleEmails: ["member@example.com", "legacy@example.com"],
      eligibleRecipients: [
        { email: "member@example.com", listUnsubscribeUrl: "" },
        { email: "legacy@example.com", listUnsubscribeUrl: "" },
      ],
      skipped: { unconfirmed: 1, suppressed: 1 },
    });
    expect(sendConfirmation).toHaveBeenCalledTimes(2);
    expect(sendConfirmation.mock.calls.map(([call]) => call.email)).toEqual([
      "legacy@example.com",
      "waiting@example.com",
    ]);
  });

  it("does not send another automatic confirmation after the store declines the reservation", async () => {
    const states = store({});
    vi.mocked(states.reserveConfirmationSend).mockResolvedValue(null);
    const sendConfirmation = vi.fn(async () => undefined);
    const service = new NotificationRecipientPolicyService({ enabled: true, states, sendConfirmation, now: () => NOW });

    await service.prepareDelivery({
      workspaceId: "workspace-id",
      workspaceName: "Acme",
      agentName: "Concierge",
      emails: ["waiting@example.com"],
      idempotencyKey: "request-id",
    });

    expect(sendConfirmation).not.toHaveBeenCalled();
  });

  it("releases a failed send reservation so a later delivery can retry", async () => {
    const states = store({});
    const service = new NotificationRecipientPolicyService({
      enabled: true,
      states,
      sendConfirmation: vi.fn(async () => { throw new Error("provider unavailable"); }),
      now: () => NOW,
    });

    await expect(service.prepareDelivery({
      workspaceId: "workspace-id",
      workspaceName: "Acme",
      agentName: "Concierge",
      emails: ["waiting@example.com"],
      idempotencyKey: "request-id",
    })).rejects.toThrow("provider unavailable");
    expect(states.releaseConfirmationSend).toHaveBeenCalledWith("recipient:waiting@example.com", NOW);
  });

  it("treats confirmation as not required when the deployment switch is off", async () => {
    const states = store({ "bounced@example.com": "suppressed" });
    const service = new NotificationRecipientPolicyService({
      enabled: false,
      states,
      sendConfirmation: vi.fn(),
      now: () => NOW,
    });

    await expect(service.describe("workspace-id", ["A@example.com", "bounced@example.com"]))
      .resolves.toEqual([
        { email: "a@example.com", state: "confirmation_not_required" },
        { email: "bounced@example.com", state: "suppressed" },
      ]);
  });

  it("keeps an explicit revocation effective when the deployment switch is off", async () => {
    const states = store({ "stopped@example.com": "revoked" });
    const service = new NotificationRecipientPolicyService({
      enabled: false,
      states,
      sendConfirmation: vi.fn(),
      now: () => NOW,
    });

    await expect(service.describe("workspace-id", ["stopped@example.com"]))
      .resolves.toEqual([{ email: "stopped@example.com", state: "revoked" }]);
  });

  it("confirms and revokes only through the state store", async () => {
    const states = store({});
    const service = new NotificationRecipientPolicyService({ enabled: true, states, sendConfirmation: vi.fn(), now: () => NOW });

    await service.confirm("recipient-id");
    await service.revoke("recipient-id");

    expect(states.confirm).toHaveBeenCalledWith("recipient-id", NOW);
    expect(states.revoke).toHaveBeenCalledWith("recipient-id", NOW);
  });
});
