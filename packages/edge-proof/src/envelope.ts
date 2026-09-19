import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/u;

export const DEFAULT_ENVELOPE_MAX_AGE_MS = 60_000;

export interface EnvelopeProof {
  signature: string;
  timestamp: string;
}

const canonicalPayload = (input: {
  context: string;
  method: string;
  path: string;
  payload: string;
  timestamp: string;
}): string => [
  input.context,
  input.timestamp,
  input.method.toUpperCase(),
  input.path,
  input.payload,
].join("\n");

const signingKey = (context: string, secret: string): Buffer =>
  createHmac("sha256", secret).update(context).digest();

const signatureFor = (input: {
  context: string;
  method: string;
  path: string;
  payload: string;
  secret: string;
  timestamp: string;
}): string => createHmac("sha256", signingKey(input.context, input.secret))
  .update(canonicalPayload(input))
  .digest("base64url");

/**
 * True when a timestamp (seconds since epoch, as a decimal string) parses and
 * falls inside the allowed clock-skew window. Shared by `verifyEnvelope` and
 * by callers (such as the edge-facts proof) that need to distinguish a stale
 * envelope from one that failed on signature alone.
 */
export const isEnvelopeTimestampFresh = (
  timestamp: string,
  options: { maxAgeMs?: number; now?: Date } = {},
): boolean => {
  if (!/^\d{1,13}$/u.test(timestamp)) return false;
  const timestampMs = Number(timestamp) * 1000;
  const nowMs = (options.now ?? new Date()).getTime();
  return Number.isSafeInteger(timestampMs)
    && Math.abs(nowMs - timestampMs) <= (options.maxAgeMs ?? DEFAULT_ENVELOPE_MAX_AGE_MS);
};

/**
 * Signs a canonical `context\ntimestamp\nMETHOD\npath\npayload` string with a
 * per-context derived key (`HMAC(secret, context)`), domain-separating every
 * caller of this envelope from every other by construction.
 */
export const signEnvelope = (input: {
  context: string;
  method: string;
  now?: Date;
  path: string;
  payload: string;
  secret: string;
}): EnvelopeProof => {
  const timestamp = Math.floor((input.now ?? new Date()).getTime() / 1000).toString();
  return {
    signature: signatureFor({ ...input, timestamp }),
    timestamp,
  };
};

export const verifyEnvelope = (input: {
  context: string;
  maxAgeMs?: number;
  method: string;
  now?: Date;
  path: string;
  payload: string;
  secret: string;
  signature: string;
  timestamp: string;
}): boolean => {
  if (!isEnvelopeTimestampFresh(input.timestamp, { maxAgeMs: input.maxAgeMs, now: input.now })) {
    return false;
  }
  if (!BASE64URL_SHA256.test(input.signature)) {
    return false;
  }
  const expected = signatureFor(input);
  const actualBytes = Buffer.from(input.signature, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

/**
 * Resolves only the configured suffix of a proxy-appended X-Forwarded-For
 * chain. Caller-controlled prefixes are never parsed or selected. Returns the
 * raw address (never a digest); callers that must not retain the address
 * digest it themselves at their own boundary.
 */
export const resolveTrustedForwardedAddress = (input: {
  forwardedFor?: string | readonly string[];
  socketAddress?: string | null;
  trustedProxyHops?: number;
}): string | null => {
  const trustedProxyHops = input.trustedProxyHops ?? 0;
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops <= 0) {
    return input.socketAddress ?? null;
  }

  const forwardedFor = Array.isArray(input.forwardedFor)
    ? input.forwardedFor.join(",")
    : input.forwardedFor;
  if (typeof forwardedFor !== "string") return input.socketAddress ?? null;

  const entries = forwardedFor.split(",").map((entry) => entry.trim());
  if (entries.length < trustedProxyHops) return input.socketAddress ?? null;

  const trustedSuffix = entries.slice(-trustedProxyHops);
  if (trustedSuffix.some((entry) => isIP(entry) === 0)) return input.socketAddress ?? null;

  return trustedSuffix[0];
};
