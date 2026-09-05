import { createHash, randomBytes } from "node:crypto";

import {
  OPERATOR_MCP_LIFECYCLE_SCOPE,
  OPERATOR_MCP_SCOPES,
  type OperatorMcpScope,
} from "@radioso/operator-mcp-contract";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
export const REFRESH_IDLE_TTL_SECONDS = 30 * 24 * 60 * 60;
export const REFRESH_ABSOLUTE_TTL_SECONDS = 90 * 24 * 60 * 60;

export const operatorMcpRolloutWorkspaceIds = (value: string | undefined): ReadonlySet<string> =>
  new Set((value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));

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
): { toolScopes: OperatorMcpScope[]; offlineAccess: boolean } => {
  const requested = [...new Set(value.split(/\s+/u).filter(Boolean))];
  const known = new Set<string>([...OPERATOR_MCP_SCOPES, OPERATOR_MCP_LIFECYCLE_SCOPE]);
  if (requested.some((scope) => !known.has(scope))) {
    throw new OperatorMcpProtocolError("invalid_scope", "invalid_scope");
  }
  const toolScopes = OPERATOR_MCP_SCOPES.filter((scope) => requested.includes(scope));
  if (toolScopes.length === 0) {
    throw new OperatorMcpProtocolError("invalid_scope", "At least one operator tool scope is required");
  }
  return { toolScopes, offlineAccess: requested.includes(OPERATOR_MCP_LIFECYCLE_SCOPE) };
};

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

export const generateOpaqueCredential = (): string => randomBytes(32).toString("base64url");
export const hashOpaqueCredential = (value: string): string => createHash("sha256").update(value).digest("hex");
