import { createHmac, timingSafeEqual } from "node:crypto";

type NotificationRecipientTokenAction = "confirm" | "revoke";

interface NotificationRecipientTokenSubject {
  recipientId: string;
  generation?: number;
}

const TOKEN_VERSION = 1;
const CONFIRMATION_TOKEN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const REVOCATION_TOKEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// The deployment secret also signs sessions, so tokens use a key derived for this purpose only.
const tokenKey = (secret: string): Buffer =>
  createHmac("sha256", secret).update("radioso:notification-recipient-token").digest();

const signature = (key: Buffer, payload: string): Buffer =>
  createHmac("sha256", key).update(payload).digest();

export class NotificationRecipientTokenSigner {
  private readonly key: Buffer;

  constructor(secret: string, private readonly options: {
    now?: () => Date;
    maxAgeMs?: number;
  } = {}) {
    if (secret.length < 16) {
      throw new Error("Notification recipient token secret must be at least 16 characters");
    }
    this.key = tokenKey(secret);
  }

  sign(recipientId: string, action: NotificationRecipientTokenAction, generation?: number): string {
    if (action === "confirm" && (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0)) {
      throw new Error("Confirmation tokens require a recipient generation");
    }
    const confirmationGeneration = action === "confirm" ? generation as number : undefined;
    const issuedAt = this.now().getTime();
    const payload = Buffer.from(JSON.stringify({
      v: TOKEN_VERSION,
      recipientId,
      action,
      ...(action === "confirm" ? { generation: confirmationGeneration } : {}),
      issuedAt,
      expiresAt: issuedAt + this.maxAgeMs(action),
    })).toString("base64url");
    return `${payload}.${signature(this.key, payload).toString("base64url")}`;
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
    const expected = signature(this.key, payload);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
      const record = decoded as Record<string, unknown>;
      if (record.v !== TOKEN_VERSION
        || record.action !== expectedAction
        || typeof record.recipientId !== "string"
        || record.recipientId.length === 0
        || !Number.isSafeInteger(record.issuedAt)
        || !Number.isSafeInteger(record.expiresAt)) return null;
      if (expectedAction === "confirm" && (!Number.isSafeInteger(record.generation) || (record.generation as number) < 0)) return null;
      if (expectedAction === "revoke" && record.generation !== undefined) return null;
      const issuedAt = record.issuedAt as number;
      const expiresAt = record.expiresAt as number;
      if (expiresAt <= issuedAt || expiresAt - issuedAt > this.maxAgeMs(expectedAction) || now.getTime() >= expiresAt) return null;
      return expectedAction === "confirm"
        ? { recipientId: record.recipientId, generation: record.generation as number }
        : { recipientId: record.recipientId };
    } catch {
      return null;
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private maxAgeMs(action: NotificationRecipientTokenAction): number {
    return action === "confirm"
      ? this.options.maxAgeMs ?? CONFIRMATION_TOKEN_MAX_AGE_MS
      : REVOCATION_TOKEN_MAX_AGE_MS;
  }
}
