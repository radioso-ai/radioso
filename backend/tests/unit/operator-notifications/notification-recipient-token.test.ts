import { describe, expect, it } from "vitest";

import { NotificationRecipientTokenSigner } from "../../../src/modules/operatorNotifications/notificationRecipientToken.js";

describe("NotificationRecipientTokenSigner", () => {
  const issuedAt = new Date("2026-10-13T12:00:00.000Z");
  const signer = new NotificationRecipientTokenSigner("a deployment secret that is long enough", { now: () => issuedAt });

  it("binds a token to one recipient record and one action without embedding an address", () => {
    const token = signer.sign("018f4c41-a873-7ad5-b1ab-45f4f83c6220", "confirm", 3);

    expect(token).not.toContain("person@example.com");
    expect(signer.verify(token, "confirm")).toEqual({ recipientId: "018f4c41-a873-7ad5-b1ab-45f4f83c6220", generation: 3 });
    expect(signer.verify(token, "revoke")).toBeNull();
  });

  it("rejects modified and malformed tokens", () => {
    const token = signer.sign("018f4c41-a873-7ad5-b1ab-45f4f83c6220", "revoke");

    expect(signer.verify(`${token}x`, "revoke")).toBeNull();
    expect(signer.verify("not-a-token", "revoke")).toBeNull();
  });

  it("rejects a token after its bounded expiry", () => {
    const token = signer.sign("recipient-id", "confirm", 1);
    const expired = new Date(issuedAt.getTime() + (14 * 24 * 60 * 60 * 1000));

    expect(signer.verify(token, "confirm", expired)).toBeNull();
  });

  it("keeps a revocation token valid across confirmation generations for its longer expiry", () => {
    const token = signer.sign("recipient-id", "revoke");
    const later = new Date(issuedAt.getTime() + (15 * 24 * 60 * 60 * 1000));

    expect(signer.verify(token, "revoke", later)).toEqual({ recipientId: "recipient-id" });
  });
});
