import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const PUBLIC_CHAT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const publicChatSessionPayloadSchema = z.object({
  workspaceId: z.string().uuid(),
  publicChatToken: z.string().min(1),
  publicSessionId: z.string().uuid(),
  sourceChannel: z.enum(["anonymous", "website_embed"]),
  sourceOrigin: z.string().min(1).nullable(),
  expiresAt: z.string().datetime(),
});

export type PublicChatSessionPayload = z.infer<typeof publicChatSessionPayloadSchema>;

const toBase64Url = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const fromBase64Url = (value: string) => Buffer.from(value, "base64url").toString("utf8");

const signPayload = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

export const issuePublicChatSession = (
  secret: string,
  input: Omit<PublicChatSessionPayload, "expiresAt">,
): PublicChatSessionPayload & { token: string } => {
  const payload: PublicChatSessionPayload = {
    ...input,
    expiresAt: new Date(Date.now() + PUBLIC_CHAT_SESSION_TTL_MS).toISOString(),
  };

  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = signPayload(secret, encodedPayload);

  return {
    ...payload,
    token: `${encodedPayload}.${signature}`,
  };
};

export const verifyPublicChatSession = (
  token: string | undefined,
  secret: string | undefined,
): PublicChatSessionPayload | null => {
  if (!token || !secret) {
    return null;
  }

  const [encodedPayload, providedSignature] = token.split(".");
  if (!encodedPayload || !providedSignature) {
    return null;
  }

  const expectedSignature = signPayload(secret, encodedPayload);
  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = publicChatSessionPayloadSchema.safeParse(JSON.parse(fromBase64Url(encodedPayload)));
    if (!parsed.success) {
      return null;
    }

    if (Date.parse(parsed.data.expiresAt) <= Date.now()) {
      return null;
    }

    return parsed.data;
  } catch {
    return null;
  }
};
