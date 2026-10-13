import { createHmac, timingSafeEqual } from "node:crypto";

type NotificationRecipientTokenAction = "confirm" | "revoke";

interface NotificationRecipientTokenSubject {
  recipientId: string;
  generation: number;
}

const TOKEN_VERSION = 1;
const TOKEN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const signature = (secret: string, payload: string): Buffer =>
  createHmac("sha256", secret).update(payload).digest();

export class NotificationRecipientTokenSigner {
  constructor(private readonly secret: string, private readonly options: {
    now?: () => Date;
    maxAgeMs?: number;
  } = {}) {
    if (secret.length < 16) {
      throw new Error("Notification recipient token secret must be at least 16 characters");
    }
  }

  sign(recipientId: string, action: NotificationRecipientTokenAction, generation: number): string {
    const issuedAt = this.now().getTime();
    const payload = Buffer.from(JSON.stringify({
      v: TOKEN_VERSION,
      recipientId,
      action,
      generation,
      issuedAt,
      expiresAt: issuedAt + this.maxAgeMs(),
    })).toString("base64url");
    return `${payload}.${signature(this.secret, payload).toString("base64url")}`;
  }

  verify(token: string, expectedAction: NotificationRecipientTokenAction, now = this.now()): NotificationRecipientTokenSubject | null {
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
      if (record.v !== TOKEN_VERSION
        || record.action !== expectedAction
        || typeof record.recipientId !== "string"
        || record.recipientId.length === 0
        || !Number.isSafeInteger(record.generation)
        || (record.generation as number) < 0
        || !Number.isSafeInteger(record.issuedAt)
        || !Number.isSafeInteger(record.expiresAt)) return null;
      const issuedAt = record.issuedAt as number;
      const expiresAt = record.expiresAt as number;
      if (expiresAt <= issuedAt || expiresAt - issuedAt > this.maxAgeMs() || now.getTime() >= expiresAt) return null;
      return { recipientId: record.recipientId, generation: record.generation as number };
    } catch {
      return null;
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private maxAgeMs(): number {
    return this.options.maxAgeMs ?? TOKEN_MAX_AGE_MS;
  }
}
