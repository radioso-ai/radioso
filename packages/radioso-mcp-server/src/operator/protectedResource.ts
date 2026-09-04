import {
  OPERATOR_MCP_PROTOCOL_VERSION,
  OPERATOR_MCP_SCOPES,
} from "@radioso/operator-mcp-contract";

export interface OperatorProtectedResourceConfig {
  authorizationServerUrl: string;
  resource: string;
}

export const createOperatorProtectedResourceMetadata = (config: OperatorProtectedResourceConfig): Record<string, unknown> => ({
  authorization_servers: [config.authorizationServerUrl],
  bearer_methods_supported: ["header"],
  mcp_protocol_version: OPERATOR_MCP_PROTOCOL_VERSION,
  resource: config.resource,
  scopes_supported: [...OPERATOR_MCP_SCOPES],
});

const quote = (value: string): string => `"${value.replace(/[\\"]/gu, "\\$&")}"`;

export const createOperatorBearerChallenge = (input: {
  metadataUrl: string;
  error?: "invalid_token" | "insufficient_scope";
  scope?: string;
}): string => {
  const fields = [`resource_metadata=${quote(input.metadataUrl)}`];
  if (input.error) fields.push(`error=${quote(input.error)}`);
  if (input.scope) fields.push(`scope=${quote(input.scope)}`);
  return `Bearer ${fields.join(", ")}`;
};

