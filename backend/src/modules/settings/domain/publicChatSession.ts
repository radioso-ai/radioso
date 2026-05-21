import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const PUBLIC_CHAT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LAUNCH_TOKEN_BINDING_KEY_LABEL = "radioso/public-chat-session-launch-token/v1";

const publicChatSessionBasePayloadSchema = z.object({
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid().optional(),
  publicSessionId: z.string().uuid(),
  sourceChannel: z.enum(["anonymous", "website_embed"]),
  sourceOrigin: z.string().min(1).nullable(),
  expiresAt: z.string().datetime(),
});

const publicChatSessionPayloadSchema = z.union([
  publicChatSessionBasePayloadSchema.extend({
    launchTokenBinding: z.string().min(1),
  }),
  publicChatSessionBasePayloadSchema.extend({
    publicChatToken: z.string().min(1),
  }),
]);

export type PublicChatSessionPayload = z.infer<typeof publicChatSessionPayloadSchema>;
type PublicChatSessionClaims = z.infer<typeof publicChatSessionBasePayloadSchema>;
type IssuePublicChatSessionInput = Omit<PublicChatSessionClaims, "expiresAt"> & {
  publicChatToken: string;
};

const toBase64Url = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const fromBase64Url = (value: string) => Buffer.from(value, "base64url").toString("utf8");

const signPayload = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

const deriveLaunchTokenBindingKey = (secret: string): Buffer =>
  createHmac("sha256", secret).update(LAUNCH_TOKEN_BINDING_KEY_LABEL).digest();

const signLaunchTokenBinding = (secret: string, launchToken: string) =>
  createHmac("sha256", deriveLaunchTokenBindingKey(secret)).update(launchToken).digest("base64url");

const safelyEqual = (actual: string, expected: string) => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
};

export const issuePublicChatSession = (
  secret: string,
  input: IssuePublicChatSessionInput,
): Extract<PublicChatSessionPayload, { launchTokenBinding: string }> & { token: string } => {
  const { publicChatToken, ...claims } = input;
  const payload: Extract<PublicChatSessionPayload, { launchTokenBinding: string }> = {
    ...claims,
    launchTokenBinding: signLaunchTokenBinding(secret, publicChatToken),
    expiresAt: new Date(Date.now() + PUBLIC_CHAT_SESSION_TTL_MS).toISOString(),
  };

  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = signPayload(secret, encodedPayload);

  return {
    ...payload,
    token: `${encodedPayload}.${signature}`,
  };
};

export const publicChatSessionMatchesLaunchToken = (
  payload: PublicChatSessionPayload,
  secret: string | undefined,
  launchToken: string,
): boolean => {
  if ("launchTokenBinding" in payload) {
    if (!secret) {
      return false;
    }

    return safelyEqual(payload.launchTokenBinding, signLaunchTokenBinding(secret, launchToken));
  }

  return payload.publicChatToken === launchToken;
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
  if (!safelyEqual(providedSignature, expectedSignature)) {
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
