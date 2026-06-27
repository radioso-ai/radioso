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

export interface VerifySignedIdentityInput {
  token: string;
  workspaceId: string;
  agentId: string;
  boundSessionId: string;
  boundOrigin: string;
  now: number;
  secrets: string[];
  acceptanceWindowMs?: number;
  isNonceUsed: (nonce: string) => Promise<boolean>;
  markNonceUsed: (nonce: string, expiresAt: number) => Promise<void>;
}

export interface VerifiedVisitorIdentity {
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

export const verifySignedIdentity = async (
  input: VerifySignedIdentityInput,
): Promise<VerifiedVisitorIdentity | null> => {
  try {
    const [encodedPayload, providedSignature, extra] = input.token.split(".");
    if (!encodedPayload || !providedSignature || extra !== undefined || input.secrets.length === 0) {
      return null;
    }

    if (!signatureMatches(input, encodedPayload, providedSignature)) {
      return null;
    }

    const parsed = signedIdentityPayloadSchema.safeParse(JSON.parse(fromBase64Url(encodedPayload)));
    if (!parsed.success) {
      return null;
    }
    const payload = parsed.data;
    const acceptanceWindowMs = input.acceptanceWindowMs ?? DEFAULT_ACCEPTANCE_WINDOW_MS;

    if (Math.abs(input.now - payload.issuedAt) > acceptanceWindowMs) {
      return null;
    }
    if (payload.sessionId !== input.boundSessionId || payload.origin !== input.boundOrigin) {
      return null;
    }
    if (await input.isNonceUsed(payload.nonce)) {
      return null;
    }

    await input.markNonceUsed(payload.nonce, payload.issuedAt + acceptanceWindowMs);
    return {
      customerId: payload.customerId,
      attributes: payload.attributes ?? {},
    };
  } catch {
    return null;
  }
};
