import { createHmac, createHash, randomBytes } from "node:crypto";

export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export const issueOpaqueToken = (prefix: string, signingSecret: string, now: Date = new Date()): string => {
  const nonce = randomBytes(24).toString("base64url");
  const issuedAt = now.getTime().toString(36);
  const signature = createHmac("sha256", signingSecret)
    .update(`${prefix}.${nonce}.${issuedAt}`)
    .digest("base64url");

  return `${prefix}_${nonce}_${issuedAt}_${signature}`;
};

export const isExpired = (expiresAt: Date, now: Date = new Date()): boolean => expiresAt.getTime() <= now.getTime();
