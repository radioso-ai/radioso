import { describe, expect, it, vi } from "vitest";

import { NotificationRecipientConfirmationMailer } from "../../../src/modules/operatorNotifications/notificationRecipientConfirmationMailer.js";
import { NotificationRecipientTokenSigner } from "../../../src/modules/operatorNotifications/notificationRecipientToken.js";

describe("NotificationRecipientConfirmationMailer", () => {
  it("sends a purpose-bound confirmation and one-click revocation link", async () => {
    const send = vi.fn(async () => ({ dispatched: true }));
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
      idempotencyKey: "notification-recipient-confirmation:request-id:recipient-id",
    }));
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
});
