import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { CopilotToolShape } from "../operatorCopilot/public.js";

export const OPERATOR_MCP_TOOL_SCOPES = [
  "operator:read",
  "operator:probe",
  "operator:act",
  "operator:propose",
] as const;
export type OperatorMcpToolScope = (typeof OPERATOR_MCP_TOOL_SCOPES)[number];

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
export const REFRESH_IDLE_TTL_SECONDS = 30 * 24 * 60 * 60;
export const REFRESH_ABSOLUTE_TTL_SECONDS = 90 * 24 * 60 * 60;

export class OperatorMcpProtocolError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "invalid_scope"
      | "invalid_client"
      | "invalid_grant"
      | "unsupported_grant_type",
    message: string,
  ) {
    super(message);
  }
}

export const parseOperatorMcpScopes = (
  value: string,
): { toolScopes: OperatorMcpToolScope[]; offlineAccess: boolean } => {
  const requested = [...new Set(value.split(/\s+/u).filter(Boolean))];
  const known = new Set<string>([...OPERATOR_MCP_TOOL_SCOPES, "offline_access"]);
  if (requested.some((scope) => !known.has(scope))) {
    throw new OperatorMcpProtocolError("invalid_scope", "invalid_scope");
  }
  const toolScopes = OPERATOR_MCP_TOOL_SCOPES.filter((scope) => requested.includes(scope));
  if (toolScopes.length === 0) {
    throw new OperatorMcpProtocolError("invalid_scope", "At least one operator tool scope is required");
  }
  return { toolScopes, offlineAccess: requested.includes("offline_access") };
};

export const scopeForToolShape = (shape: CopilotToolShape): OperatorMcpToolScope =>
  `operator:${shape}` as OperatorMcpToolScope;

export const validateAuthorizationResource = (requested: string, canonical: string): string => {
  if (requested !== canonical) {
    throw new OperatorMcpProtocolError("invalid_request", "The exact operator MCP resource is required");
  }
  return requested;
};

export const validateRedirectUri = (input: {
  applicationType: "web" | "native";
  requested: string;
  registered: readonly string[];
}): string => {
  let requested: URL;
  try {
    requested = new URL(input.requested);
  } catch {
    throw new OperatorMcpProtocolError("invalid_request", "Invalid redirect URI");
  }
  if (requested.hash || requested.username || requested.password) {
    throw new OperatorMcpProtocolError("invalid_request", "Invalid redirect URI");
  }

  if (input.applicationType === "web") {
    if (requested.protocol !== "https:" || !input.registered.includes(requested.toString())) {
      throw new OperatorMcpProtocolError("invalid_request", "Invalid redirect URI");
    }
    return requested.toString();
  }

  if (requested.protocol !== "http:" || (requested.hostname !== "127.0.0.1" && requested.hostname !== "[::1]")) {
    throw new OperatorMcpProtocolError("invalid_request", "Invalid redirect URI");
  }
  const matched = input.registered.some((candidate) => {
    try {
      const registered = new URL(candidate);
      return registered.protocol === requested.protocol
        && registered.hostname === requested.hostname
        && registered.pathname === requested.pathname
        && registered.search === requested.search
        && registered.hash === requested.hash;
    } catch {
      return false;
    }
  });
  if (!matched) throw new OperatorMcpProtocolError("invalid_request", "Invalid redirect URI");
  return requested.toString();
};

const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;

export const validatePkceS256 = (verifier: string, challenge: string): boolean => {
  if (!PKCE_VERIFIER.test(verifier)) return false;
  const actual = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const generateOpaqueCredential = (): string => randomBytes(32).toString("base64url");
export const hashOpaqueCredential = (value: string): string => createHash("sha256").update(value).digest("hex");

const canonicalSerialize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalSerialize(item)}`)
    .join(",")}}`;
};

export const canonicalInputDigest = (value: unknown, key: string): string =>
  `v1:${createHmac("sha256", key).update("radioso:operator-mcp:input:v1\0").update(canonicalSerialize(value)).digest("hex")}`;
