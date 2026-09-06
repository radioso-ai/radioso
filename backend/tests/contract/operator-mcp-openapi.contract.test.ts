import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";

describe("operator MCP OpenAPI contract", () => {
  it("publishes the session-authenticated setup, grant, and consent JSON routes", () => {
    const paths = createOpenApiDocument().paths ?? {};

    expect(paths["/api/v1/workspaces/{workspaceId}/operator-mcp/setup"]?.get).toMatchObject({
      operationId: "getOperatorMcpSetup",
      security: [{ sessionCookie: [] }],
    });
    expect(paths["/api/v1/workspaces/{workspaceId}/operator-mcp/grants"]?.get).toMatchObject({
      operationId: "listOperatorMcpGrants",
      security: [{ sessionCookie: [] }],
    });
    expect(paths["/api/v1/workspaces/{workspaceId}/operator-mcp/grants/{grantId}"]?.get).toMatchObject({
      operationId: "getOperatorMcpGrant",
    });
    expect(paths["/api/v1/workspaces/{workspaceId}/operator-mcp/grants/{grantId}/revoke"]?.post).toMatchObject({
      operationId: "revokeOperatorMcpGrant",
      parameters: expect.arrayContaining([expect.objectContaining({ name: "X-Radioso-CSRF", in: "header", required: true })]),
    });
    expect(paths["/api/v1/operator-mcp/oauth/transactions/{transactionId}"]?.get).toMatchObject({
      operationId: "getOperatorMcpConsentTransaction",
      security: [{ sessionCookie: [] }],
    });
    expect(paths["/api/v1/operator-mcp/oauth/transactions/{transactionId}/decision"]?.post).toMatchObject({
      operationId: "decideOperatorMcpConsentTransaction",
      parameters: expect.arrayContaining([expect.objectContaining({ name: "X-Radioso-CSRF", in: "header", required: true })]),
    });
  });

  it("keeps the form/redirect OAuth endpoints and internal transport routes out of the public JSON SDK", () => {
    const paths = createOpenApiDocument().paths ?? {};

    expect(paths["/api/v1/operator-mcp/oauth/authorize"]).toBeUndefined();
    expect(paths["/api/v1/operator-mcp/oauth/token"]).toBeUndefined();
    expect(paths["/api/v1/operator-mcp/oauth/revoke"]).toBeUndefined();
    expect(paths["/api/v1/internal/operator-copilot/mcp/admissions"]).toBeUndefined();
  });
});
