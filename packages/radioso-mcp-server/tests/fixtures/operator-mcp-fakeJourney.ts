import {
  OPERATOR_MCP_LIFECYCLE_SCOPE,
  OPERATOR_MCP_PROTOCOL_VERSION,
  OPERATOR_MCP_SCOPES,
  OperatorProtectedResourceMetadataSchema,
  createOperatorMcpProof,
  sha256Digest,
} from "@radioso/operator-mcp-contract";
import { createOperatorMcpRequestHandler } from "../../src/operator/requestHandler.js";

const RESOURCE = "https://mcp.example/operator/mcp";
const METADATA_URL = "https://mcp.example/.well-known/oauth-protected-resource/operator/mcp";
const AUTHORIZATION_SERVER = "https://app.example";
const ID = "00000000-0000-4000-8000-000000000001";
const SECRET = "fake-operator-contract-proof-key";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface FakeTokens { accessToken: string; refreshToken: string }

export const runFakeOperatorJourney = async (): Promise<{ status: string }> => {
  const protectedMetadata = OperatorProtectedResourceMetadataSchema.parse({
    authorization_servers: [AUTHORIZATION_SERVER],
    bearer_methods_supported: ["header"],
    resource: RESOURCE,
    scopes_supported: [...OPERATOR_MCP_SCOPES],
  });
  invariant(protectedMetadata.resource === RESOURCE, "resource discovery mismatch");
  invariant(!protectedMetadata.scopes_supported.includes(OPERATOR_MCP_LIFECYCLE_SCOPE as never), "lifecycle scope leaked into resource metadata");
  const authorizationMetadata = {
    authorization_endpoint: `${AUTHORIZATION_SERVER}/oauth/authorize`,
    grant_types_supported: ["authorization_code", "refresh_token"],
    issuer: AUTHORIZATION_SERVER,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...OPERATOR_MCP_SCOPES, OPERATOR_MCP_LIFECYCLE_SCOPE],
    token_endpoint: `${AUTHORIZATION_SERVER}/oauth/token`,
  };
  invariant(authorizationMetadata.scopes_supported.includes(OPERATOR_MCP_LIFECYCLE_SCOPE), "offline access missing from AS discovery");

  const verifier = "v".repeat(43);
  const challenge = sha256Digest(verifier);
  const state = "state-bound-to-browser-transaction";
  const code = "authorization-code-once";
  let consumedCode = false;
  let revoked = false;
  let tokens: FakeTokens = { accessToken: "access-1", refreshToken: "refresh-1" };
  let consumedRefresh = false;

  const authorize = (input: { state: string; resource: string; codeChallenge: string }): URL => {
    invariant(input.resource === RESOURCE, "authorization audience mismatch");
    invariant(input.codeChallenge === challenge, "PKCE challenge mismatch");
    const redirect = new URL("http://127.0.0.1:43123/oauth/callback");
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", input.state);
    return redirect;
  };
  const callback = authorize({ codeChallenge: challenge, resource: RESOURCE, state });
  invariant(callback.searchParams.get("state") === state, "OAuth state was not returned");

  const exchangeCode = (presentedCode: string, presentedVerifier: string, resource: string): FakeTokens => {
    invariant(!consumedCode && presentedCode === code, "authorization code replay");
    invariant(presentedVerifier === verifier && resource === RESOURCE, "token exchange binding mismatch");
    consumedCode = true;
    return tokens;
  };
  const refresh = (presentedRefresh: string, resource: string): FakeTokens => {
    if (revoked) throw new Error("refresh lineage revoked");
    if (consumedRefresh) {
      revoked = true;
      throw new Error("refresh replay revoked lineage");
    }
    invariant(presentedRefresh === tokens.refreshToken && resource === RESOURCE, "refresh audience mismatch");
    consumedRefresh = true;
    tokens = { accessToken: "access-2", refreshToken: "refresh-2" };
    return tokens;
  };
  const revoke = (presentedToken: string): void => {
    invariant(presentedToken === tokens.accessToken, "unexpected revoke token");
    revoked = true;
  };

  const handler = createOperatorMcpRequestHandler({
    admit: async ({ accessToken, method }) => {
      if (revoked || accessToken !== tokens.accessToken) return null;
      const proofInput = {
        accountId: ID,
        bodyDigest: sha256Digest("{}"),
        clientId: "https://client.example/cimd",
        clientMetadataSnapshotId: ID,
        clientVersion: "1",
        credentialEpoch: "1",
        credentialId: ID,
        expiresAt: Date.now() + 10_000,
        grantId: ID,
        grantVersion: "1",
        invocationId: ID,
        issuedAt: Date.now() - 100,
        issuedOfflineAccess: true,
        issuedToolScopes: ["operator:read" as const],
        method,
        nonce: `nonce-${method}`,
        resource: RESOURCE,
        userId: ID,
        version: 1 as const,
        workspaceId: ID,
      };
      return { proof: createOperatorMcpProof({ ...proofInput, secret: SECRET }) };
    },
    call: async ({ name, arguments: args }) => ({ content: [{ type: "text", text: `${name}:${String(args.query ?? "ok")}` }] }),
    list: async () => ({ tools: [{ description: "Read current workspace settings", inputSchema: {}, name: "workspace_settings", requiredScope: "operator:read", shape: "read" }] }),
    resourceMetadataUrl: METADATA_URL,
  });
  const resourceRequest = async (accessToken: string, body: unknown): Promise<Response> => handler(new Request(RESOURCE, {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    method: "POST",
  }));

  const issued = exchangeCode(code, verifier, RESOURCE);
  let response = await resourceRequest(issued.accessToken, { id: 1, jsonrpc: "2.0", method: "tools/list", protocolVersion: OPERATOR_MCP_PROTOCOL_VERSION });
  invariant(response.status === 200, "tools/list was not accepted");
  response = await resourceRequest(issued.accessToken, { id: 2, jsonrpc: "2.0", method: "tools/call", params: { arguments: { query: "ok" }, name: "workspace_settings", operationId: "operation-1" }, protocolVersion: OPERATOR_MCP_PROTOCOL_VERSION });
  invariant(response.status === 200, "tools/call was not accepted");

  const rotated = refresh(issued.refreshToken, RESOURCE);
  invariant(rotated.accessToken !== issued.accessToken && rotated.refreshToken !== issued.refreshToken, "refresh did not rotate credentials");
  let refreshReplayRejected = false;
  try { refresh(issued.refreshToken, RESOURCE); } catch { refreshReplayRejected = true; }
  invariant(refreshReplayRejected, "consumed refresh credential was accepted");
  response = await resourceRequest(rotated.accessToken, { id: 3, jsonrpc: "2.0", method: "ping", protocolVersion: OPERATOR_MCP_PROTOCOL_VERSION });
  invariant(response.status === 401, "revoked token was accepted");
  let successorRefreshRejected = false;
  try { refresh(rotated.refreshToken, RESOURCE); } catch { successorRefreshRejected = true; }
  invariant(successorRefreshRejected, "successor refresh credential survived replay revocation");
  // Revocation remains an idempotent explicit lifecycle operation after the
  // replay path has already revoked the lineage.
  revoke(rotated.accessToken);
  response = await resourceRequest(rotated.accessToken, { id: 4, jsonrpc: "2.0", method: "tools/list", protocolVersion: OPERATOR_MCP_PROTOCOL_VERSION });
  invariant(response.status === 401, "explicitly revoked token was accepted");
  return { status: "revoked" };
};
