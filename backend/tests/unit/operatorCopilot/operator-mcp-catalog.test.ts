import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { OperatorMcpCatalogService } from "../../../src/modules/operatorCopilot/mcpCatalog.js";
import type { CopilotToolDescriptor, CopilotToolInvocationContext } from "../../../src/modules/operatorCopilot/public.js";

const currentAuthorization = { hasAllPermissions: vi.fn(async () => true) };
const context: CopilotToolInvocationContext = {
  workspaceId: "workspace", accountId: "account", operatorUserId: "user", surface: "mcp",
  permissions: new Set(["workspace.settings.read"]), currentAuthorization,
  operatorMcpInvocationId: "00000000-0000-4000-8000-000000000001",
  pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
};

const descriptor = (name: string, scope: "operator:read" | "operator:probe", status: "eligible" | "excluded" = "eligible"): CopilotToolDescriptor => ({
  name, shape: scope === "operator:read" ? "read" : "probe", verificationCost: () => scope === "operator:read" ? 0 : 1,
  uiLabel: name, description: `${name} description`, inputSchema: z.object({ key: z.string() }).strict(),
  outputSchema: z.object({ value: z.string() }).strict(), requiredPermissions: ["workspace.settings.read"],
  contributingModule: "test", dashboardSubject: { type: "settings" },
  mcpDisposition: status === "eligible"
    ? { status: "eligible", inputStrategy: "explicit", scope, retry: { effect: "none", idempotent: true, requiresOperationId: false } }
    : { status: "excluded", reason: "not reviewed" },
  createTool: () => ({
    name, description: name, inputSchema: z.object({ key: z.string() }), outputSchema: z.object({ value: z.string() }),
    invoke: vi.fn(async ({ key }: { key: string }) => ({ value: key })),
  }),
});

describe("OperatorMcpCatalogService", () => {
  it("projects only exact eligible descriptors allowed by current scope and permissions", async () => {
    const service = new OperatorMcpCatalogService([descriptor("workspace_settings", "operator:read"), descriptor("retrieval_probe", "operator:probe"), descriptor("hidden", "operator:read", "excluded")]);
    const catalog = await service.list({ context, scopes: new Set(["operator:read"]) });
    expect(catalog.map((tool) => [tool.name, tool.shape, tool.requiredScope])).toEqual([["workspace_settings", "read", "operator:read"]]);
    expect(catalog[0]?.inputSchema).toMatchObject({ type: "object" });
  });

  it("rejects guessed names and stale scope before invocation", async () => {
    const service = new OperatorMcpCatalogService([descriptor("workspace_settings", "operator:read")]);
    await expect(service.invoke({ name: "Workspace Settings", arguments: { key: "x" }, context, scopes: new Set(["operator:read"]), signal: AbortSignal.timeout(1000) })).rejects.toMatchObject({ code: "unknown_tool" });
    await expect(service.invoke({ name: "workspace_settings", arguments: { key: "x" }, context, scopes: new Set(["operator:probe"]), signal: AbortSignal.timeout(1000) })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("validates arguments and reauthorizes before and after the direct call", async () => {
    currentAuthorization.hasAllPermissions.mockClear();
    const service = new OperatorMcpCatalogService([descriptor("workspace_settings", "operator:read")]);
    await expect(service.invoke({ name: "workspace_settings", arguments: { key: "safe" }, context, scopes: new Set(["operator:read"]), signal: AbortSignal.timeout(1000) })).resolves.toEqual({ value: "safe" });
    expect(currentAuthorization.hasAllPermissions).toHaveBeenCalledTimes(2);
    await expect(service.invoke({ name: "workspace_settings", arguments: { wrong: true }, context, scopes: new Set(["operator:read"]), signal: AbortSignal.timeout(1000) })).rejects.toMatchObject({ code: "invalid_arguments" });
  });
});
