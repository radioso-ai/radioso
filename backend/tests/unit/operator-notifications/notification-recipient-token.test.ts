import { describe, expect, it } from "vitest";

import { NotificationRecipientTokenSigner } from "../../../src/modules/operatorNotifications/notificationRecipientToken.js";

describe("NotificationRecipientTokenSigner", () => {
  const signer = new NotificationRecipientTokenSigner("a deployment secret that is long enough");

  it("binds a token to one recipient record and one action without embedding an address", () => {
    const token = signer.sign("018f4c41-a873-7ad5-b1ab-45f4f83c6220", "confirm");

    expect(token).not.toContain("person@example.com");
    expect(signer.verify(token, "confirm")).toBe("018f4c41-a873-7ad5-b1ab-45f4f83c6220");
    expect(signer.verify(token, "revoke")).toBeNull();
  });

  it("rejects modified and malformed tokens", () => {
    const token = signer.sign("018f4c41-a873-7ad5-b1ab-45f4f83c6220", "revoke");

    expect(signer.verify(`${token}x`, "revoke")).toBeNull();
    expect(signer.verify("not-a-token", "revoke")).toBeNull();
  });
});
