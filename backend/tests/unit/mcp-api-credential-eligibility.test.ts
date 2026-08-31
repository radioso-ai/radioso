import { describe, expect, it } from "vitest";

import { isApiPrincipalRejectedByMcp } from "../../src/app/http/mcpContextSupport.js";

describe("MCP API credential eligibility", () => {
  it.each([
    {
      type: "personal_api_credential" as const,
      userId: "user-1",
      credentialId: "credential-1",
      role: "member" as const,
      workspaceId: "workspace-1",
    },
    {
      type: "service_account_credential" as const,
      serviceAccountId: "service-1",
      credentialId: "credential-2",
      role: "admin" as const,
      workspaceId: "workspace-1",
    },
  ])("rejects $type", (principal) => {
    expect(isApiPrincipalRejectedByMcp(principal)).toBe(true);
  });

  it("does not classify non-API principals as MCP API credentials", () => {
    expect(isApiPrincipalRejectedByMcp({
      type: "session_user",
      userId: "user-1",
    })).toBe(false);
  });
});
