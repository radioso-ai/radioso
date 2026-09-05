import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const PROOF_CONTEXT = "radioso:mcp-source-proof:v1";
const DEFAULT_MAX_AGE_MS = 60_000;
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/u;

export const MCP_SOURCE_PROOF_HEADERS = {
  digest: "x-radioso-mcp-source-digest",
  signature: "x-radioso-mcp-source-signature",
  timestamp: "x-radioso-mcp-source-timestamp",
} as const;

export interface McpSourceProof {
  signature: string;
  sourceDigest: string;
  timestamp: string;
}

export const digestSourceAddress = (address: string): string =>
  createHmac("sha256", "radioso:source-address:v1").update(address).digest("base64url");

/**
 * Resolves only the configured suffix of a proxy-appended X-Forwarded-For
 * chain. Caller-controlled prefixes are never parsed or selected. The raw
 * address is digested inside this boundary and is never returned.
 */
export const resolveSourceDigest = (input: {
  forwardedFor?: string | readonly string[];
  socketAddress?: string | null;
  trustedProxyHops?: number;
}): string => {
  const socketDigest = digestSourceAddress(input.socketAddress ?? "unknown");
  const trustedProxyHops = input.trustedProxyHops ?? 0;
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops <= 0) return socketDigest;

  const forwardedFor = Array.isArray(input.forwardedFor)
    ? input.forwardedFor.join(",")
    : input.forwardedFor;
  if (typeof forwardedFor !== "string") return socketDigest;
  const entries = forwardedFor.split(",").map((entry) => entry.trim());
  if (entries.length < trustedProxyHops) return socketDigest;
  const trustedSuffix = entries.slice(-trustedProxyHops);
  if (trustedSuffix.some((entry) => isIP(entry) === 0)) return socketDigest;
  return digestSourceAddress(trustedSuffix[0]);
};

const canonicalPayload = (input: {
  method: string;
  path: string;
  sourceDigest: string;
  timestamp: string;
}): string => [
  PROOF_CONTEXT,
  input.timestamp,
  input.method.toUpperCase(),
  input.path,
  input.sourceDigest,
].join("\n");

const signingKey = (secret: string): Buffer =>
  createHmac("sha256", secret).update(PROOF_CONTEXT).digest();

const signatureFor = (input: {
  method: string;
  path: string;
  secret: string;
  sourceDigest: string;
  timestamp: string;
}): string => createHmac("sha256", signingKey(input.secret))
  .update(canonicalPayload(input))
  .digest("base64url");

export const createMcpSourceProof = (input: {
  method: string;
  now?: Date;
  path: string;
  secret: string;
  sourceDigest: string;
}): McpSourceProof => {
  if (!SHA256_BASE64URL.test(input.sourceDigest)) {
    throw new Error("MCP source proof requires a SHA-256 base64url digest.");
  }
  const timestamp = Math.floor((input.now ?? new Date()).getTime() / 1000).toString();
  return {
    signature: signatureFor({ ...input, timestamp }),
    sourceDigest: input.sourceDigest,
    timestamp,
  };
};

export const verifyMcpSourceProof = (input: McpSourceProof & {
  maxAgeMs?: number;
  method: string;
  now?: Date;
  path: string;
  secret: string;
}): string | null => {
  if (!SHA256_BASE64URL.test(input.sourceDigest) || !/^\d{1,13}$/u.test(input.timestamp)) {
    return null;
  }
  const timestampMs = Number(input.timestamp) * 1000;
  const nowMs = (input.now ?? new Date()).getTime();
  if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > (input.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) {
    return null;
  }
  const expected = signatureFor(input);
  if (!SHA256_BASE64URL.test(input.signature)) {
    return null;
  }
  const actualBytes = Buffer.from(input.signature, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
    ? input.sourceDigest
    : null;
};
