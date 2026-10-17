import { describe, expect, it, vi } from "vitest";

import { NotificationRecipientConfirmationMailer } from "../../../src/modules/operatorNotifications/notificationRecipientConfirmationMailer.js";
import { NotificationRecipientTokenSigner } from "../../../src/modules/operatorNotifications/notificationRecipientToken.js";
import { notificationRecipientPublicApiBase } from "../../../src/app/composition/contactDelivery.js";

describe("NotificationRecipientConfirmationMailer", () => {
  it.each([
    [{ CONNECTOR_PUBLIC_BASE_URL: "https://api.example.com", APP_BASE_URL: "https://app.example.com", PORT: 3001 }, "https://api.example.com"],
    [{ CONNECTOR_PUBLIC_BASE_URL: undefined, APP_BASE_URL: "https://app.example.com", PORT: 3001 }, "https://app.example.com/backend"],
  ] as const)("resolves the public API base for %o", (env, expected) => {
    expect(notificationRecipientPublicApiBase(env)).toBe(expected);
  });

  it("sends a purpose-bound confirmation and one-click revocation link", async () => {
    const messages: Array<{ text: string; listUnsubscribeUrl: string }> = [];
    const send = vi.fn(async (message: { text: string; listUnsubscribeUrl: string }) => {
      messages.push(message);
      return { dispatched: true };
    });
    const mailer = new NotificationRecipientConfirmationMailer({
      mailer: { send },
      signer: new NotificationRecipientTokenSigner("a deployment secret that is long enough"),
      publicBaseUrl: "https://api.example.com/",
    });

    await mailer.send({
      workspaceId: "workspace-id",
      workspaceName: "Ananda",
      agentName: "Reception",
      email: "francesco@example.com",
      recipientId: "recipient-id",
      generation: 4,
      idempotencyKey: "request-id",
    });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: "francesco@example.com",
      kind: "recipient_confirmation",
      subject: "Ananda wants to send you Reception notifications via Radioso",
      text: expect.stringMatching(/confirm\?token=[A-Za-z0-9_.-]+/u),
      listUnsubscribeUrl: expect.stringMatching(/revoke\?token=[A-Za-z0-9_.-]+/u),
      idempotencyKey: "notification-recipient-confirmation:request-id:recipient-id:4",
    }));
    const message = messages[0];
    expect(message?.text).toContain("https://api.example.com/api/v1/notification-recipient-confirmations/confirm?token=");
    expect(message?.listUnsubscribeUrl).toContain("https://api.example.com/api/v1/notification-recipient-confirmations/revoke?token=");
  });

  it("keeps tenant-authored names too short to carry a message of their own", async () => {
    const send = vi.fn(async (_message: { subject: string; text: string }) => ({ dispatched: true }));
    const mailer = new NotificationRecipientConfirmationMailer({
      mailer: { send },
      signer: new NotificationRecipientTokenSigner("a deployment secret that is long enough"),
      publicBaseUrl: "https://api.example.com/",
    });

    await mailer.send({
      workspaceId: "workspace-id",
      workspaceName: `Cheap watches ${"x".repeat(200)} visit spam.example`,
      agentName: "Reception",
      email: "francesco@example.com",
      recipientId: "recipient-id",
      generation: 1,
      idempotencyKey: "request-id",
    });

    const [message] = send.mock.calls[0];
    expect(message.subject).not.toContain("spam.example");
    expect(message.text).not.toContain("spam.example");
    expect(message.subject.startsWith("Cheap watches")).toBe(true);
  });

  it("reports an undispatched log or noop send without recording it as sent", async () => {
    const send = vi.fn(async () => ({ dispatched: false }));
    const incrementCounter = vi.fn();
    const mailer = new NotificationRecipientConfirmationMailer({
      mailer: { send },
      signer: new NotificationRecipientTokenSigner("a deployment secret that is long enough"),
      publicBaseUrl: "https://api.example.com/",
      metrics: { incrementCounter },
    });

    await expect(mailer.send({
      workspaceId: "workspace-id", workspaceName: "Ananda", agentName: "Reception",
      email: "francesco@example.com", recipientId: "recipient-id", generation: 0, idempotencyKey: "request-id",
    })).resolves.toEqual({ dispatched: false });
    expect(incrementCounter).not.toHaveBeenCalled();
  });

  it("keeps the backend path when the public API is proxied below the dashboard", async () => {
    const messages: Array<{ text: string; listUnsubscribeUrl: string }> = [];
    const send = vi.fn(async (message: { text: string; listUnsubscribeUrl: string }) => {
      messages.push(message);
      return { dispatched: true };
    });
    const mailer = new NotificationRecipientConfirmationMailer({
      mailer: { send },
      signer: new NotificationRecipientTokenSigner("a deployment secret that is long enough"),
      publicBaseUrl: "https://app.example.com/backend",
    });

    await mailer.send({
      workspaceId: "workspace-id", workspaceName: "Ananda", agentName: "Reception",
      email: "francesco@example.com", recipientId: "recipient-id", generation: 1, idempotencyKey: "request-id",
    });

    const message = messages[0];
    expect(message?.text).toContain("https://app.example.com/backend/api/v1/notification-recipient-confirmations/confirm?token=");
    expect(message?.listUnsubscribeUrl).toContain("https://app.example.com/backend/api/v1/notification-recipient-confirmations/revoke?token=");
  });
});
