import { createHmac } from "node:crypto";
import { isIP } from "node:net";

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

const IPV6_HEXTET_COUNT = 8;
const IPV6_NETWORK_HEXTETS = 4;

/** A dotted IPv4 address as the two IPv6 groups it occupies at the end of an IPv6 address. */
const ipv4Hextets = (ipv4: string): string => {
  const [a = 0, b = 0, c = 0, d = 0] = ipv4.split(".").map(Number);
  return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
};

/** Expands a valid IPv6 address (already checked with `isIP`) to its eight 16-bit groups. */
const ipv6Hextets = (address: string): number[] => {
  const [withoutZone = ""] = address.split("%", 1);
  const lastColon = withoutZone.lastIndexOf(":");
  const tail = withoutZone.slice(lastColon + 1);
  const hexForm = isIP(tail) === 4
    ? `${withoutZone.slice(0, lastColon + 1)}${ipv4Hextets(tail)}`
    : withoutZone;
  const [head = "", rest] = hexForm.split("::");
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const headGroups = groups(head);
  const tailGroups = groups(rest);
  const zeros = rest === undefined ? [] : new Array<string>(IPV6_HEXTET_COUNT - headGroups.length - tailGroups.length).fill("0");
  return [...headGroups, ...zeros, ...tailGroups].map((group) => Number.parseInt(group, 16));
};

const isIpv4Mapped = (hextets: number[]): boolean =>
  hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff;

/**
 * What a source budget is keyed on. An IPv6 caller usually holds a whole /64,
 * so keying on the full address would let it mint a fresh budget per address;
 * it is keyed on its /64 instead, and an IPv4-mapped IPv6 address on the IPv4
 * address it carries. IPv4 and anything that is not an IP address are used as
 * given.
 */
const sourceBudgetKey = (address: string): string => {
  if (isIP(address) !== 6) return address;

  const hextets = ipv6Hextets(address);
  if (isIpv4Mapped(hextets)) {
    const [high = 0, low = 0] = hextets.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return `${hextets.slice(0, IPV6_NETWORK_HEXTETS).map((hextet) => hextet.toString(16)).join(":")}::/64`;
};

export const digestSourceAddress = (address: string): string =>
  createHmac("sha256", "radioso:source-address:v1").update(sourceBudgetKey(address)).digest("base64url");

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
