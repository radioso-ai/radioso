import { createHmac, timingSafeEqual } from "node:crypto";

type NotificationRecipientTokenAction = "confirm" | "revoke";

const TOKEN_VERSION = 1;

const signature = (secret: string, payload: string): Buffer =>
  createHmac("sha256", secret).update(payload).digest();

export class NotificationRecipientTokenSigner {
  constructor(private readonly secret: string) {
    if (secret.length < 16) {
      throw new Error("Notification recipient token secret must be at least 16 characters");
    }
  }

  sign(recipientId: string, action: NotificationRecipientTokenAction): string {
    const payload = Buffer.from(JSON.stringify({ v: TOKEN_VERSION, recipientId, action })).toString("base64url");
    return `${payload}.${signature(this.secret, payload).toString("base64url")}`;
  }

  verify(token: string, expectedAction: NotificationRecipientTokenAction): string | null {
    const [payload, encodedSignature, extra] = token.split(".");
    if (!payload || !encodedSignature || extra !== undefined) return null;
    let presented: Buffer;
    try {
      presented = Buffer.from(encodedSignature, "base64url");
    } catch {
      return null;
    }
    const expected = signature(this.secret, payload);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
      const record = decoded as Record<string, unknown>;
      return record.v === TOKEN_VERSION
        && record.action === expectedAction
        && typeof record.recipientId === "string"
        && record.recipientId.length > 0
        ? record.recipientId
        : null;
    } catch {
      return null;
    }
  }
}
