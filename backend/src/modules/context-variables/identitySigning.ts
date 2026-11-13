import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const VISITOR_IDENTITY_KEY_LABEL = "radioso/visitor-identity/v1";
const DEFAULT_ACCEPTANCE_WINDOW_MS = 5 * 60 * 1000;

const signedIdentityPayloadSchema = z.object({
  customerId: z.string().min(1).max(500),
  sessionId: z.string().min(1).max(500),
  origin: z.string().min(1).max(2048),
  issuedAt: z.number().int().finite(),
  nonce: z.string().min(1).max(500),
  attributes: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type SignedVisitorIdentityPayload = z.infer<typeof signedIdentityPayloadSchema>;

interface VerifySignedIdentityInput {
  token: string;
  workspaceId: string;
  agentId: string;
  boundSessionId: string;
  /**
   * The origin the token must have been minted for. A browser-hosted caller always has
   * one; an MCP converse session has no client-facing bootstrap and therefore no origin,
   * so it supplies none and the session binding, issuance window, and single-use nonce
   * carry the verification on their own. `origin` stays required on the payload as a
   * recorded, untrusted caller-declared value.
   */
  boundOrigin?: string | null;
  now: number;
  secrets: string[];
  acceptanceWindowMs?: number;
  isNonceUsed: (nonce: string) => Promise<boolean>;
  markNonceUsed: (nonce: string, expiresAt: number) => Promise<void>;
}

interface VerifiedVisitorIdentity {
  customerId: string;
  attributes: Record<string, unknown>;
}

const toBase64Url = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const fromBase64Url = (value: string) => Buffer.from(value, "base64url").toString("utf8");

const safelyEqual = (actual: string, expected: string): boolean => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
};

export const deriveVisitorIdentitySigningKey = (
  workspaceTokenSecret: string,
  workspaceId: string,
  agentId: string,
): Buffer =>
  createHmac("sha256", workspaceTokenSecret)
    .update(`${VISITOR_IDENTITY_KEY_LABEL}/${workspaceId}/${agentId}`)
    .digest();

const signEncodedPayload = (
  workspaceTokenSecret: string,
  workspaceId: string,
  agentId: string,
  encodedPayload: string,
): string =>
  createHmac("sha256", deriveVisitorIdentitySigningKey(workspaceTokenSecret, workspaceId, agentId))
    .update(encodedPayload)
    .digest("base64url");

export const signVisitorIdentity = (
  secret: string,
  workspaceId: string,
  agentId: string,
  payload: SignedVisitorIdentityPayload,
): string => {
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  return `${encodedPayload}.${signEncodedPayload(secret, workspaceId, agentId, encodedPayload)}`;
};

const signatureMatches = (
  input: Pick<VerifySignedIdentityInput, "workspaceId" | "agentId" | "secrets">,
  encodedPayload: string,
  providedSignature: string,
): boolean =>
  input.secrets.some((secret) => {
    if (!secret) {
      return false;
    }
    const expectedSignature = signEncodedPayload(secret, input.workspaceId, input.agentId, encodedPayload);
    return safelyEqual(providedSignature, expectedSignature);
  });

/**
 * The longest token the verifier reads. A longer one is refused before anything is split, decoded
 * or signed over, so a caller cannot make the check do work in proportion to what it sends; the
 * request that carries it still answers normally, as an unidentified turn.
 */
const SIGNED_IDENTITY_MAX_TOKEN_LENGTH = 8192;

/** Why a token did not verify, as a closed set a counter can label with. */
export type SignedIdentityRejection =
  | "too_long"
  | "not_configured"
  | "malformed"
  | "invalid_signature"
  | "invalid_payload"
  | "expired"
  | "wrong_session"
  | "wrong_origin"
  | "replayed"
  | "error";

export type SignedIdentityOutcome =
  | { outcome: "verified"; identity: VerifiedVisitorIdentity }
  | { outcome: SignedIdentityRejection };

/** Verifies a token and says which check refused it. It never throws and never echoes the token. */
export const verifySignedIdentityOutcome = async (
  input: VerifySignedIdentityInput,
): Promise<SignedIdentityOutcome> => {
  try {
    if (input.token.length > SIGNED_IDENTITY_MAX_TOKEN_LENGTH) {
      return { outcome: "too_long" };
    }
    if (!input.secrets.some(Boolean)) {
      return { outcome: "not_configured" };
    }
    const [encodedPayload, providedSignature, extra] = input.token.split(".");
    if (!encodedPayload || !providedSignature || extra !== undefined) {
      return { outcome: "malformed" };
    }

    if (!signatureMatches(input, encodedPayload, providedSignature)) {
      return { outcome: "invalid_signature" };
    }

    const parsed = signedIdentityPayloadSchema.safeParse(JSON.parse(fromBase64Url(encodedPayload)));
    if (!parsed.success) {
      return { outcome: "invalid_payload" };
    }
    const payload = parsed.data;
    const acceptanceWindowMs = input.acceptanceWindowMs ?? DEFAULT_ACCEPTANCE_WINDOW_MS;

    if (Math.abs(input.now - payload.issuedAt) > acceptanceWindowMs) {
      return { outcome: "expired" };
    }
    if (payload.sessionId !== input.boundSessionId) {
      return { outcome: "wrong_session" };
    }
    if (input.boundOrigin != null && payload.origin !== input.boundOrigin) {
      return { outcome: "wrong_origin" };
    }
    if (await input.isNonceUsed(payload.nonce)) {
      return { outcome: "replayed" };
    }

    await input.markNonceUsed(payload.nonce, payload.issuedAt + acceptanceWindowMs);
    return {
      outcome: "verified",
      identity: {
        customerId: payload.customerId,
        attributes: payload.attributes ?? {},
      },
    };
  } catch {
    return { outcome: "error" };
  }
};

export const verifySignedIdentity = async (
  input: VerifySignedIdentityInput,
): Promise<VerifiedVisitorIdentity | null> => {
  const result = await verifySignedIdentityOutcome(input);
  return result.outcome === "verified" ? result.identity : null;
};
