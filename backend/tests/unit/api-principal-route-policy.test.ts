import { describe, expect, it } from "vitest";
import { allowsMachinePrincipal, apiPrincipalRoutePolicy } from "../../src/app/http/apiPrincipalRoutePolicy.js";

const personal = { type: "personal_api_credential" as const, userId: "user", credentialId: "credential", role: "member" as const, workspaceId: "workspace" };
const service = { type: "service_account_credential" as const, serviceAccountId: "service", credentialId: "credential", role: "admin" as const, workspaceId: "workspace" };

describe("API principal route policy", () => {
  it("defaults machine credentials to denied and retains session-only identity surfaces", () => {
    expect(allowsMachinePrincipal("GET", "/api/v1/account/users", personal)).toBe(false);
    expect(allowsMachinePrincipal("GET", "/api/v1/unknown", personal)).toBe(false);
    expect(apiPrincipalRoutePolicy["GET /api/v1/workspace/summary"]?.sessionOnly).toBe(false);
  });

  it("records router-wide authenticated connector routes as explicit session-only decisions", () => {
    for (const key of [
      "GET /api/v1/connectors",
      "GET /api/v1/connectors/:connectorId",
      "PUT /api/v1/connectors/:connectorId",
      "POST /api/v1/connectors/:connectorId/enable",
      "POST /api/v1/connectors/:connectorId/disable",
      "POST /api/v1/connectors/:connectorId/sync",
    ]) {
      expect(apiPrincipalRoutePolicy[key], `${key} needs an explicit policy`).toMatchObject({ sessionOnly: true });
    }
  });

  it("records account and application-contributed session routes explicitly", () => {
    for (const key of [
      "GET /api/v1/account/users",
      "POST /api/v1/account/switch",
      "GET /api/v1/account/usage-trends",
      "GET /api/v1/quality/audience-pulse",
      "POST /api/v1/quality/audience-pulse/evidence-anchor",
      "GET /api/v1/ee/usage-limits/me",
    ]) {
      expect(apiPrincipalRoutePolicy[key], `${key} needs an explicit policy`).toMatchObject({ sessionOnly: true });
    }
  });

  it.each([
    ["POST", "/api/v1/settings/general/anonymous-chat-token/rotate"],
    ["POST", "/api/v1/settings/general/website-embed-token/rotate"],
    ["POST", "/api/v1/agents/agent-1/channel-credentials"],
    ["GET", "/api/v1/agents/agent-1/context-variables/signing-key"],
    ["GET", "/api/v1/settings/credentials"],
    ["GET", "/api/v1/workspace/mcp/context"],
    ["GET", "/api/v1/connectors"],
    ["POST", "/api/v1/conversations/conversation-1/takeover"],
    ["GET", "/api/v1/copilot"],
  ])("rejects API credentials on sensitive %s %s", (method, path) => {
    expect(allowsMachinePrincipal(method, path, personal)).toBe(false);
    expect(allowsMachinePrincipal(method, path, service)).toBe(false);
  });

  it.each([
    ["POST", "/api/v1/retrieval/search"],
    ["POST", "/api/v1/agents/agent-1/routines/routine-1/publish"],
    ["GET", "/api/v1/document/document-1/chunks"],
    ["PUT", "/api/v1/context-variables/variable-1/values"],
  ])("allows declared ordinary %s %s operations", (method, path) => {
    expect(allowsMachinePrincipal(method, path, personal)).toBe(true);
    expect(allowsMachinePrincipal(method, path, service)).toBe(true);
  });

  it.each([
    ["GET", "/api/v1/settings"],
    ["PUT", "/api/v1/settings"],
    ["GET", "/api/v1/settings/general"],
    ["PUT", "/api/v1/settings/general"],
  ])("keeps public-launch-bearing %s %s session-only", (method, path) => {
    expect(allowsMachinePrincipal(method, path, personal)).toBe(false);
    expect(allowsMachinePrincipal(method, path, service)).toBe(false);
  });

  it.each([
    ["GET", "/api/v1/agents"],
    ["POST", "/api/v1/agents"],
    ["GET", "/api/v1/agents/agent-1"],
    ["PUT", "/api/v1/agents/agent-1"],
  ])("allows ordinary agent authoring %s %s with bearer-safe presentation", (method, path) => {
    expect(allowsMachinePrincipal(method, path, personal)).toBe(true);
    expect(allowsMachinePrincipal(method, path, service)).toBe(true);
  });

  it("does not treat an allowed path as a prefix wildcard", () => {
    expect(allowsMachinePrincipal("GET", "/api/v1/skills/unlisted/child", personal)).toBe(false);
    expect(allowsMachinePrincipal("POST", "/api/v1/assistant/chat/unsafe-child", personal)).toBe(false);
  });
});
