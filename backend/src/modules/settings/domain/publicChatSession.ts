import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import type { AgentConverseOrigin } from "../contracts/agentConverseSession.js";

/**
 * Absolute lifetime of a signed session, shared by the public chat session and the MCP
 * converse session (credential-bound and walk-in alike). It is absolute rather than idle:
 * the token carries its own expiry and nothing refreshes it, so a busy caller cannot
 * extend a session indefinitely by staying busy (FR-031a).
 */
const PUBLIC_CHAT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LAUNCH_TOKEN_BINDING_KEY_LABEL = "radioso/public-chat-session-launch-token/v1";
const PUBLIC_CHAT_RESUME_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESUME_TOKEN_SIGNING_KEY_LABEL = "radioso/public-chat-session-resume/v1";

const publicChatSessionBasePayloadSchema = z.object({
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid().optional(),
  publicSessionId: z.string().uuid(),
  sourceChannel: z.enum(["anonymous", "website_embed"]),
  sourceOrigin: z.string().min(1).nullable(),
  expiresAt: z.string().datetime(),
  /**
   * Spec 1277 decision 6: an unauthenticated, client-persisted visitor-grouping
   * id — separate from `publicSessionId` on purpose. It grants no session, no
   * resume, and no history-read power; it only lets `VisitorResolver` group
   * conversations under one operator-visible `visitors` row. Fixed for the life
   * of a session: set from the client's bootstrap request only when there is no
   * resume token, and carried unchanged (never client-overridable) across a
   * resume. Not present on the MCP converse payload — that surface has no
   * client-facing bootstrap for this to originate from.
   */
  visitorKey: z.string().uuid().nullable().optional(),
});

const converseChatSessionClaimsSchema = z.object({
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  publicSessionId: z.string().uuid(),
  sourceChannel: z.literal("mcp"),
  sourceOrigin: z.null(),
  expiresAt: z.string().datetime(),
});

const converseChatSessionOriginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("grant"),
    grantId: z.string().uuid(),
    grantVersion: z.string().min(1),
  }),
  z.object({
    kind: z.literal("walk_in"),
    publicId: z.string().min(1).max(128),
  }),
]);

const converseChatSessionPayloadSchema = z.union([
  converseChatSessionClaimsSchema.extend({
    origin: converseChatSessionOriginSchema,
  }),
  /**
   * Sessions signed before the origin became a union carried the grant flat. Kept for
   * exactly one release so tokens minted by the previous deploy keep working, then
   * dropped together with this comment.
   */
  converseChatSessionClaimsSchema
    .extend({
      grantId: z.string().uuid(),
      grantVersion: z.string().min(1),
    })
    .transform(({ grantId, grantVersion, ...claims }): ConverseChatSessionPayload => ({
      ...claims,
      origin: { kind: "grant", grantId, grantVersion },
    })),
]);

const publicChatSessionPayloadSchema = z.union([
  publicChatSessionBasePayloadSchema.extend({
    launchTokenBinding: z.string().min(1),
  }),
  publicChatSessionBasePayloadSchema.extend({
    publicChatToken: z.string().min(1),
  }),
]);

type PublicChatSessionPayload = z.infer<typeof publicChatSessionPayloadSchema>;
export type ConverseChatSessionPayload = z.infer<typeof converseChatSessionClaimsSchema> & {
  origin: AgentConverseOrigin;
};
type PublicChatSessionClaims = z.infer<typeof publicChatSessionBasePayloadSchema>;
type IssuePublicChatSessionInput = Omit<PublicChatSessionClaims, "expiresAt"> & {
  publicChatToken: string;
};
type IssueConverseChatSessionInput = Omit<ConverseChatSessionPayload, "expiresAt" | "sourceChannel" | "sourceOrigin">;

const publicChatResumePayloadSchema = publicChatSessionBasePayloadSchema.extend({
  launchTokenBinding: z.string().min(1),
});

export type PublicChatResumePayload = z.infer<typeof publicChatResumePayloadSchema>;

const toBase64Url = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const fromBase64Url = (value: string) => Buffer.from(value, "base64url").toString("utf8");

const signPayload = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

const deriveLaunchTokenBindingKey = (secret: string): Buffer =>
  createHmac("sha256", secret).update(LAUNCH_TOKEN_BINDING_KEY_LABEL).digest();

const signLaunchTokenBinding = (secret: string, launchToken: string) =>
  createHmac("sha256", deriveLaunchTokenBindingKey(secret)).update(launchToken).digest("base64url");

const deriveResumeTokenSigningKey = (secret: string): Buffer =>
  createHmac("sha256", secret).update(RESUME_TOKEN_SIGNING_KEY_LABEL).digest();

const signResumePayload = (secret: string, payload: string) =>
  createHmac("sha256", deriveResumeTokenSigningKey(secret)).update(payload).digest("base64url");

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

export const issueConverseChatSession = (
  secret: string,
  input: IssueConverseChatSessionInput,
): ConverseChatSessionPayload & { token: string } => {
  const payload: ConverseChatSessionPayload = {
    ...input,
    sourceChannel: "mcp",
    sourceOrigin: null,
    expiresAt: new Date(Date.now() + PUBLIC_CHAT_SESSION_TTL_MS).toISOString(),
  };

  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = signPayload(secret, encodedPayload);

  return {
    ...payload,
    token: `${encodedPayload}.${signature}`,
  };
};

export const issuePublicChatResumeToken = (
  secret: string,
  input: IssuePublicChatSessionInput,
): PublicChatResumePayload & { token: string } => {
  const { publicChatToken, ...claims } = input;
  const payload: PublicChatResumePayload = {
    ...claims,
    launchTokenBinding: signLaunchTokenBinding(secret, publicChatToken),
    expiresAt: new Date(Date.now() + PUBLIC_CHAT_RESUME_TOKEN_TTL_MS).toISOString(),
  };

  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = signResumePayload(secret, encodedPayload);

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

export const verifyConverseChatSession = (
  token: string | undefined,
  secret: string | undefined,
): ConverseChatSessionPayload | null => {
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
    const parsed = converseChatSessionPayloadSchema.safeParse(JSON.parse(fromBase64Url(encodedPayload)));
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

export const verifyPublicChatResumeToken = (
  token: string | undefined,
  secret: string | undefined,
  launchToken: string,
): PublicChatResumePayload | null => {
  if (!token || !secret) {
    return null;
  }

  const [encodedPayload, providedSignature] = token.split(".");
  if (!encodedPayload || !providedSignature) {
    return null;
  }

  const expectedSignature = signResumePayload(secret, encodedPayload);
  if (!safelyEqual(providedSignature, expectedSignature)) {
    return null;
  }

  try {
    const parsed = publicChatResumePayloadSchema.safeParse(JSON.parse(fromBase64Url(encodedPayload)));
    if (!parsed.success) {
      return null;
    }

    if (Date.parse(parsed.data.expiresAt) <= Date.now()) {
      return null;
    }

    if (!safelyEqual(parsed.data.launchTokenBinding, signLaunchTokenBinding(secret, launchToken))) {
      return null;
    }

    return parsed.data;
  } catch {
    return null;
  }
};
