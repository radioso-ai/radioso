import { createHmac } from "node:crypto";

import {
  resolveTrustedForwardedAddress,
  signEnvelope,
  verifyEnvelope,
} from "@radioso/edge-proof";

const PROOF_CONTEXT = "radioso:mcp-source-proof:v1";
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
 * chain (via `@radioso/edge-proof`). Caller-controlled prefixes are never
 * parsed or selected. The raw address is digested inside this boundary and
 * is never returned.
 */
export const resolveSourceDigest = (input: {
  forwardedFor?: string | readonly string[];
  socketAddress?: string | null;
  trustedProxyHops?: number;
}): string => digestSourceAddress(resolveTrustedForwardedAddress(input) ?? "unknown");

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
  const { signature, timestamp } = signEnvelope({
    context: PROOF_CONTEXT,
    method: input.method,
    path: input.path,
    secret: input.secret,
    payload: input.sourceDigest,
    now: input.now,
  });
  return { signature, sourceDigest: input.sourceDigest, timestamp };
};

export const verifyMcpSourceProof = (input: McpSourceProof & {
  maxAgeMs?: number;
  method: string;
  now?: Date;
  path: string;
  secret: string;
}): string | null => {
  if (!SHA256_BASE64URL.test(input.sourceDigest)) {
    return null;
  }
  const verified = verifyEnvelope({
    context: PROOF_CONTEXT,
    method: input.method,
    path: input.path,
    secret: input.secret,
    payload: input.sourceDigest,
    signature: input.signature,
    timestamp: input.timestamp,
    now: input.now,
    maxAgeMs: input.maxAgeMs,
  });
  return verified ? input.sourceDigest : null;
};
