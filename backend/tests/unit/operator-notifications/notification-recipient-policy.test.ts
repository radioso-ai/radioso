import { describe, expect, it, vi } from "vitest";

import {
  NOTIFICATION_CONFIRMATION_LIMITS,
  NotificationRecipientPolicyService,
} from "../../../src/modules/operatorNotifications/notificationRecipientPolicy.js";

const NOW = new Date("2026-10-13T12:00:00.000Z");

type StateStore = ConstructorParameters<typeof NotificationRecipientPolicyService>[0]["states"];

const store = (states: Record<string, "confirmed" | "grandfathered" | "revoked" | "waiting_for_confirmation" | "suppressed">): StateStore => ({
  read: vi.fn(async ({ emails }: { emails: readonly string[] }) => emails.map((email: string) => ({
    email,
    state: states[email] ?? "waiting_for_confirmation",
    grandfatheredUntil: states[email] === "grandfathered" ? new Date("2026-10-20T00:00:00.000Z") : null,
  }))),
  ensure: vi.fn(async (_workspaceId: string, email: string) => ({ recipientId: `recipient:${email}`, generation: 0 })),
  reserveConfirmationSend: vi.fn(async ({ email }: { email: string }) => states[email] !== "revoked" && states[email] !== "suppressed"
    ? { recipientId: `recipient:${email}`, generation: 1, reservedAt: NOW, previousSentAt: null }
    : null),
  releaseConfirmationSend: vi.fn(async () => undefined),
  confirm: vi.fn(),
  revoke: vi.fn(),
  resume: vi.fn(async () => true),
});

describe("NotificationRecipientPolicyService", () => {
  it("delivers only confirmed and unexpired grandfathered recipients and requests confirmation without exposing addresses in outcomes", async () => {
    const states = store({
      "member@example.com": "confirmed",
      "legacy@example.com": "grandfathered",
      "bounced@example.com": "suppressed",
    });
    const sendConfirmation = vi.fn(async (_input: { email: string }) => ({ dispatched: true }));
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
      skipped: { unconfirmed: 1, suppressed: 1, revoked: 0 },
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
    const sendConfirmation = vi.fn(async (_input: { email: string }) => ({ dispatched: true }));
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

  it("releases a failed send reservation without blocking a healthy delivery", async () => {
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
    })).resolves.toMatchObject({ skipped: { unconfirmed: 1, suppressed: 0, revoked: 0 } });
    // A thrown send may still have reached the provider, so its daily slot stays spent.
    expect(states.releaseConfirmationSend).toHaveBeenCalledWith(
      { recipientId: "recipient:waiting@example.com", generation: 1, reservedAt: NOW, previousSentAt: null },
      "failed",
    );
  });

  it("releases an undispatched confirmation reservation without recording a send", async () => {
    const states = store({});
    const service = new NotificationRecipientPolicyService({
      enabled: true,
      states,
      sendConfirmation: vi.fn(async () => ({ dispatched: false })),
      now: () => NOW,
    });

    await service.prepareDelivery({
      workspaceId: "workspace-id", workspaceName: "Acme", agentName: "Concierge",
      emails: ["waiting@example.com"], idempotencyKey: "request-id",
    });

    expect(states.releaseConfirmationSend).toHaveBeenCalledWith(
      { recipientId: "recipient:waiting@example.com", generation: 1, reservedAt: NOW, previousSentAt: null },
      "not_dispatched",
    );
  });

  it("counts a recipient who stopped notifications apart from one who has not confirmed", async () => {
    const states = store({ "stopped@example.com": "revoked" });
    const service = new NotificationRecipientPolicyService({ enabled: true, states, sendConfirmation: vi.fn(async () => ({ dispatched: true })), now: () => NOW });

    await expect(service.prepareDelivery({
      workspaceId: "workspace-id", workspaceName: "Acme", agentName: "Concierge",
      emails: ["stopped@example.com"], idempotencyKey: "request-id",
    })).resolves.toMatchObject({ eligibleEmails: [], skipped: { unconfirmed: 0, suppressed: 0, revoked: 1 } });
  });

  it("looks up workspace and agent names only for a confirmation it will actually send", async () => {
    const states = store({});
    vi.mocked(states.reserveConfirmationSend).mockResolvedValue(null);
    const resolve = vi.fn(async () => ({ workspaceName: "Acme", agentName: "Concierge" }));
    const service = new NotificationRecipientPolicyService({
      enabled: true, states, sendConfirmation: vi.fn(async () => ({ dispatched: true })), identity: { resolve }, now: () => NOW,
    });

    await service.prepareDelivery({ workspaceId: "workspace-id", emails: ["a@example.com", "b@example.com"], idempotencyKey: "request-id" });
    expect(resolve).not.toHaveBeenCalled();

    vi.mocked(states.reserveConfirmationSend).mockImplementation(async ({ email }) => ({ recipientId: `recipient:${email}`, generation: 1, reservedAt: NOW, previousSentAt: null }));
    await service.prepareDelivery({ workspaceId: "workspace-id", emails: ["a@example.com", "b@example.com"], idempotencyKey: "request-id" });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("reuses a stored recipient id for the unsubscribe link instead of writing one", async () => {
    const states = store({ "member@example.com": "confirmed" });
    vi.mocked(states.read).mockResolvedValue([
      { email: "member@example.com", state: "confirmed", grandfatheredUntil: null, recipientId: "stored-id", generation: 0 },
    ]);
    const service = new NotificationRecipientPolicyService({
      enabled: true, states, sendConfirmation: vi.fn(async () => ({ dispatched: true })), now: () => NOW,
      revocationUrl: (recipientId) => `https://api.example.com/revoke/${recipientId}`,
    });

    await expect(service.prepareDelivery({ workspaceId: "workspace-id", emails: ["member@example.com"], idempotencyKey: "request-id" }))
      .resolves.toMatchObject({ eligibleRecipients: [{ email: "member@example.com", listUnsubscribeUrl: "https://api.example.com/revoke/stored-id" }] });
    expect(states.ensure).not.toHaveBeenCalled();
  });

  it("treats confirmation as not required when the deployment switch is off", async () => {
    const states = store({ "bounced@example.com": "suppressed" });
    const service = new NotificationRecipientPolicyService({
      enabled: false,
      states,
    sendConfirmation: vi.fn(async () => ({ dispatched: true })),
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
    sendConfirmation: vi.fn(async () => ({ dispatched: true })),
      now: () => NOW,
    });

    await expect(service.describe("workspace-id", ["stopped@example.com"]))
      .resolves.toEqual([{ email: "stopped@example.com", state: "revoked" }]);
  });

  it("asks newly added external addresses to confirm before any notice is due", async () => {
    const states = store({ "member@example.com": "confirmed", "stopped@example.com": "revoked" });
    const sendConfirmation = vi.fn(async (_input: { email: string }) => ({ dispatched: true }));
    const service = new NotificationRecipientPolicyService({ enabled: true, states, sendConfirmation, now: () => NOW });

    await service.requestConfirmations({
      workspaceId: "workspace-id",
      agentId: "agent-id",
      emails: ["member@example.com", "New@example.com", "stopped@example.com"],
      idempotencyKey: "change-id",
    });

    expect(sendConfirmation.mock.calls.map(([call]) => call.email)).toEqual(["new@example.com"]);
    expect(states.reserveConfirmationSend).toHaveBeenCalledWith({
      workspaceId: "workspace-id",
      email: "new@example.com",
      now: NOW,
      force: false,
      limits: NOTIFICATION_CONFIRMATION_LIMITS,
    });
  });

  it("sends no confirmation for added addresses when the deployment switch is off", async () => {
    const states = store({});
    const sendConfirmation = vi.fn(async () => ({ dispatched: true }));
    const service = new NotificationRecipientPolicyService({ enabled: false, states, sendConfirmation, now: () => NOW });

    await service.requestConfirmations({ workspaceId: "workspace-id", agentId: "agent-id", emails: ["new@example.com"], idempotencyKey: "change-id" });

    expect(sendConfirmation).not.toHaveBeenCalled();
  });

  it("resumes a stopped recipient by recipient identity", async () => {
    const states = store({});
    const service = new NotificationRecipientPolicyService({ enabled: true, states, sendConfirmation: vi.fn(async () => ({ dispatched: true })), now: () => NOW });

    await expect(service.resume({ recipientId: "recipient-id" })).resolves.toBe(true);
    expect(states.resume).toHaveBeenCalledWith("recipient-id", NOW);
  });

  it("confirms by token generation and revokes by recipient identity", async () => {
    const states = store({});
    const service = new NotificationRecipientPolicyService({ enabled: true, states, sendConfirmation: vi.fn(async () => ({ dispatched: true })), now: () => NOW });

    await service.confirm({ recipientId: "recipient-id", generation: 2 });
    await service.revoke({ recipientId: "recipient-id" });

    expect(states.confirm).toHaveBeenCalledWith("recipient-id", 2, NOW);
    expect(states.revoke).toHaveBeenCalledWith("recipient-id", NOW);
  });
});
