import { describe, expect, it } from "vitest";
import {
  OPERATOR_MCP_PROTOCOL_VERSION,
  OPERATOR_MCP_RESOURCE_PATH,
  OperatorMcpRequestSchema,
  OperatorProtectedResourceMetadataSchema,
} from "@radioso/operator-mcp-contract";

describe("operator MCP 2026-07-28 feasibility fixture", () => {
  it("uses a stateless, self-describing request and never includes initialize/session state", () => {
    const request = OperatorMcpRequestSchema.parse({
      id: "fixture-list",
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
      protocolVersion: OPERATOR_MCP_PROTOCOL_VERSION,
    });

    expect(request.protocolVersion).toBe("2026-07-28");
    expect(request.method).toBe("tools/list");
    expect(request).not.toHaveProperty("sessionId");
    expect(request.method).not.toBe("initialize");
    expect(OPERATOR_MCP_RESOURCE_PATH).toBe("/operator/mcp");
  });

  it("rejects an older protocol revision before any tool payload is accepted", () => {
    expect(() => OperatorMcpRequestSchema.parse({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "workspace_settings", arguments: { hidden: "payload" } },
      protocolVersion: "2025-11-25",
    })).toThrow();
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

