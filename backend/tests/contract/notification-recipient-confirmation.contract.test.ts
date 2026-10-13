import { createHmac } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { NotificationRecipientTokenSigner } from "../../src/modules/operatorNotifications/public.js";
import { createTestApp } from "../support/testApp.js";

describe("notification recipient confirmation contract", () => {
  it("renders public links without mutating state and confirms or revokes only on POST", async () => {
    const { app, dependencies } = createTestApp();
    const confirm = vi.spyOn(dependencies.notificationRecipientPolicy, "confirm");
    const revoke = vi.spyOn(dependencies.notificationRecipientPolicy, "revoke");
    const signer = new NotificationRecipientTokenSigner(dependencies.env.SESSION_COOKIE_SECRET);

    const confirmToken = signer.sign("recipient-id", "confirm", 0);
    const revokeToken = signer.sign("recipient-id", "revoke");
    const confirmPage = await request(app).get("/api/v1/notification-recipient-confirmations/confirm")
      .query({ token: confirmToken });
    const revokePage = await request(app).get("/api/v1/notification-recipient-confirmations/revoke")
      .query({ token: revokeToken });
    expect(confirmPage.status).toBe(200);
    expect(revokePage.status).toBe(200);
    expect(confirmPage.text).toContain('method="post"');
    expect(revokePage.text).toContain('method="post"');
    expect(confirmPage.text).toContain(`action="?token=${encodeURIComponent(confirmToken)}"`);
    expect(revokePage.text).toContain(`action="?token=${encodeURIComponent(revokeToken)}"`);
    expect(confirm).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    const confirmed = await request(app).post("/api/v1/notification-recipient-confirmations/confirm")
      .query({ token: confirmToken });
    const revoked = await request(app).post("/api/v1/notification-recipient-confirmations/revoke")
      .query({ token: revokeToken })
      .type("form")
      .send("List-Unsubscribe=One-Click");

    expect(confirmed.status).toBe(200);
    expect(confirmed.headers["cache-control"]).toBe("no-store");
    expect(confirmed.text).toContain("Stop sending me these notifications");
    expect(confirmed.text).toContain('action="?token=');
    expect(revoked.status).toBe(200);
    expect(confirm).toHaveBeenCalledWith({ recipientId: "recipient-id", generation: 0 });
    expect(revoke).toHaveBeenCalledWith({ recipientId: "recipient-id" });
  });

  it("confirms a stop to the person who asked, even when they had already stopped, and offers to resume", async () => {
    const { app, dependencies } = createTestApp();
    vi.spyOn(dependencies.notificationRecipientPolicy, "revoke").mockResolvedValue(false);
    const resume = vi.spyOn(dependencies.notificationRecipientPolicy, "resume").mockResolvedValue(true);
    const signer = new NotificationRecipientTokenSigner(dependencies.env.SESSION_COOKIE_SECRET);
    const revokeToken = signer.sign("recipient-id", "revoke");

    const stopped = await request(app).post("/api/v1/notification-recipient-confirmations/revoke")
      .query({ token: revokeToken });

    expect(stopped.status).toBe(200);
    expect(stopped.headers["content-type"]).toContain("text/html");
    expect(stopped.text).toContain(`action="resume?token=${encodeURIComponent(revokeToken)}"`);
    expect(resume).not.toHaveBeenCalled();

    const resumed = await request(app).post("/api/v1/notification-recipient-confirmations/resume")
      .query({ token: revokeToken });

    expect(resumed.status).toBe(200);
    expect(resumed.text).toContain("Stop sending me these notifications");
    expect(resume).toHaveBeenCalledWith({ recipientId: "recipient-id" });
  });

  it("rejects a confirmation token at the resume endpoint", async () => {
    const { app, dependencies } = createTestApp();
    const signer = new NotificationRecipientTokenSigner(dependencies.env.SESSION_COOKIE_SECRET);

    const response = await request(app).post("/api/v1/notification-recipient-confirmations/resume")
      .query({ token: signer.sign("recipient-id", "confirm", 0) });

    expect(response.status).toBe(400);
  });

  it("rejects a confirmation token at the revocation endpoint", async () => {
    const { app, dependencies } = createTestApp();
    const signer = new NotificationRecipientTokenSigner(dependencies.env.SESSION_COOKIE_SECRET);

    const response = await request(app).post("/api/v1/notification-recipient-confirmations/revoke")
      .query({ token: signer.sign("recipient-id", "confirm", 0) });

    expect(response.status).toBe(400);
  });

  it("records signed Resend complaints even when the inbound email channel is off", async () => {
    const secret = `whsec_${Buffer.from("notification-webhook-test-key-000").toString("base64")}`;
    const { app, dependencies } = createTestApp({
      envOverrides: { EMAIL_CHANNEL_WEBHOOK_SECRET: secret },
    });
    const suppress = vi.spyOn(dependencies.notificationRecipientSuppressions, "suppress");
    const body = Buffer.from(JSON.stringify({
      type: "email.complained",
      created_at: new Date().toISOString(),
      data: {
        email_id: "email-id",
        to: ["recipient@example.com"],
        tags: { kind: "recipient_confirmation" },
      },
    }));
    const id = "webhook-id";
    const timestamp = Math.floor(Date.now() / 1000);
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    const signature = createHmac("sha256", key)
      .update(`${id}.${timestamp}.`)
      .update(body)
      .digest("base64");

    const response = await request(app).post("/api/connectors/email/webhook")
      .set("content-type", "application/json")
      .set("svix-id", id)
      .set("svix-timestamp", String(timestamp))
      .set("svix-signature", `v1,${signature}`)
      .send(body.toString("utf8"));

    expect(response.status).toBe(200);
    expect(suppress).toHaveBeenCalledWith({
      email: "recipient@example.com",
      reason: "complaint",
      provider: "resend",
      providerEventId: id,
    });
  });
});
