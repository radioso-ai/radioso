import { describe, expect, it } from "vitest";
import {
  OPERATOR_MCP_PROTOCOL_VERSION,
  OPERATOR_MCP_RESOURCE_PATH,
  OperatorMcpRequestSchema,
  OperatorProtectedResourceMetadataSchema,
} from "@radioso/operator-mcp-contract";

describe("operator MCP 2026-07-28 feasibility fixture", () => {
  const requestMetadata = {
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "operator-test", version: "1.0.0" },
    "io.modelcontextprotocol/protocolVersion": OPERATOR_MCP_PROTOCOL_VERSION,
  };

  it("uses standard stateless request metadata and never includes initialize/session state", () => {
    const request = OperatorMcpRequestSchema.parse({
      id: "fixture-list",
      jsonrpc: "2.0",
      method: "tools/list",
      params: { _meta: requestMetadata },
    });

    expect(request.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect(request.method).toBe("tools/list");
    expect(request).not.toHaveProperty("protocolVersion");
    expect(request).not.toHaveProperty("sessionId");
    expect(request.method).not.toBe("initialize");
    expect(OPERATOR_MCP_RESOURCE_PATH).toBe("/operator/mcp");
  });

  it("rejects an older protocol revision before any tool payload is accepted", () => {
    expect(() => OperatorMcpRequestSchema.parse({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: { ...requestMetadata, "io.modelcontextprotocol/protocolVersion": "2025-11-25" },
        name: "workspace_settings",
        arguments: { hidden: "payload" },
      },
    })).toThrow();
  });

  it("accepts the mandatory server discovery request", () => {
    expect(OperatorMcpRequestSchema.parse({
      id: "discover",
      jsonrpc: "2.0",
      method: "server/discover",
      params: { _meta: requestMetadata },
    }).method).toBe("server/discover");
  });

  it("keeps protected-resource metadata limited to tool scopes", () => {
    const metadata = OperatorProtectedResourceMetadataSchema.parse({
      authorization_servers: ["https://app.example"],
      bearer_methods_supported: ["header"],
      resource: "https://mcp.example/operator/mcp",
      scopes_supported: ["operator:read", "operator:probe", "operator:act", "operator:propose"],
    });
    expect(metadata.scopes_supported).not.toContain("offline_access");
  });
});
