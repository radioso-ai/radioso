import { describe, expect, it } from "vitest";
import { createOperatorBearerChallenge, createOperatorProtectedResourceMetadata } from "../src/operator/protectedResource.js";

describe("operator protected-resource metadata", () => {
  it("advertises the exact resource and only tool scopes", () => {
    const metadata = createOperatorProtectedResourceMetadata({ authorizationServerUrl: "https://app.example", resource: "https://mcp.example/operator/mcp" });
    expect(metadata).toMatchObject({ resource: "https://mcp.example/operator/mcp", authorization_servers: ["https://app.example"], bearer_methods_supported: ["header"] });
    expect(metadata.scopes_supported).toEqual(["operator:read", "operator:probe", "operator:act", "operator:propose"]);
    expect(metadata.scopes_supported).not.toContain("offline_access");
    expect(createOperatorBearerChallenge({ metadataUrl: "https://mcp.example/.well-known/oauth-protected-resource/operator/mcp" })).toContain("resource_metadata=");
  });
});

