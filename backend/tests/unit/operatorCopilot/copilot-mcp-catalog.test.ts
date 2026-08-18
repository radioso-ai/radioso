import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { enrichCopilotToolCatalog } from "../../../src/modules/operatorCopilot/catalog.js";
import { buildCopilotDashboardLink } from "../../../src/modules/operatorCopilot/dashboardLinks.js";
import type { CopilotToolDescriptor } from "../../../src/modules/operatorCopilot/public.js";
import { createAgentConfigurationCopilotTools } from "../../../src/modules/operatorCopilot/tools/agents.js";

const context = (permissions: ReadonlySet<string>) => ({
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  permissions,
  pageContext: { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] },
});

const descriptor = (describeEntity: NonNullable<CopilotToolDescriptor<{ name: string }> ["describeEntity"]>): CopilotToolDescriptor<{ name: string }> => ({
  name: "agent_configuration",
  shape: "read",
  uiLabel: "Reading agent configuration",
  description: "Read an agent.",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ value: z.string() }),
  requiredPermission: "workspace.agents.read",
  contributingModule: "agents",
  dashboardSubject: { type: "agent" },
  describeEntity,
  createTool: () => ({
    name: "agent_configuration",
    description: "Read an agent.",
    inputSchema: z.object({ name: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    invoke: async () => ({ value: "visible" }),
  }),
});

describe("MCP-compatible copilot catalog", () => {
  it("does not resolve or expose a named entity when the caller lacks the tool permission", async () => {
    const resolve = vi.fn(async () => ({
      kind: "ambiguous" as const,
      candidates: [{ type: "agent", id: "agent-secret", label: "Secret support agent" }],
    }));
    const [tool] = enrichCopilotToolCatalog([descriptor(resolve)], {
      resolveWorkspaceKey: async () => "acme",
    });

    const result = await tool!.createTool(context(new Set())).invoke({ name: "Secret support agent" }, {} as never);

    expect(resolve).not.toHaveBeenCalled();
    expect(result).toEqual({
      dashboardUrl: "/w/acme/agents",
      resolution: { status: "not_found", candidates: [] },
    });
    expect(JSON.stringify(result)).not.toContain("Secret support agent");
  });

  it("returns same-name candidates as a normal result instead of choosing one", async () => {
    const [tool] = enrichCopilotToolCatalog([descriptor(async () => ({
      kind: "ambiguous",
      candidates: [
        { type: "agent", id: "agent-1", label: "Support" },
        { type: "agent", id: "agent-2", label: "Support" },
      ],
    }))], {
      resolveWorkspaceKey: async () => "acme",
    });

    const result = await tool!.createTool(context(new Set(["workspace.agents.read"]))).invoke({ name: "Support" }, {} as never);

    expect(result).toEqual({
      dashboardUrl: "/w/acme/agents",
      resolution: {
        status: "ambiguous",
        candidates: [
          { type: "agent", id: "agent-1", label: "Support", dashboardUrl: "/w/acme/agents/agent-1" },
          { type: "agent", id: "agent-2", label: "Support", dashboardUrl: "/w/acme/agents/agent-2" },
        ],
      },
    });
  });

  it("lets the agent-owning descriptor resolve a name without ambient page context", async () => {
    const [agentConfiguration] = createAgentConfigurationCopilotTools({
      agentService: {
        listExisting: vi.fn(async () => [
          { id: "agent-1", name: "Support" },
          { id: "agent-2", name: "Support" },
        ] as never),
        resolve: vi.fn(),
      },
    });
    const [tool] = enrichCopilotToolCatalog([agentConfiguration!], {
      resolveWorkspaceKey: async () => "acme",
    });

    const result = await tool!.createTool(context(new Set(["workspace.agents.read"]))).invoke({ agentName: "Support" }, {} as never);

    expect(result).toMatchObject({
      resolution: {
        status: "ambiguous",
        candidates: [
          { id: "agent-1", label: "Support" },
          { id: "agent-2", label: "Support" },
        ],
      },
    });
  });
});

describe("copilot dashboard links", () => {
  it("matches the dashboard workspace route shapes", () => {
    expect(buildCopilotDashboardLink("acme", { type: "workspace" })).toBe("/w/acme/agents");
    expect(buildCopilotDashboardLink("acme", { type: "workspace_settings" })).toBe("/w/acme/settings");
    expect(buildCopilotDashboardLink("acme", { type: "agent", id: "agent-1" })).toBe("/w/acme/agents/agent-1");
    expect(buildCopilotDashboardLink("acme", { type: "routine", id: "routine-1", agentId: "agent-1" })).toBe("/w/acme/agents/agent-1/routines/routine-1");
    expect(buildCopilotDashboardLink("acme", { type: "document", id: "document-1" })).toBe("/w/acme/knowledge/documents/document-1");
    expect(buildCopilotDashboardLink("acme", { type: "conversation", id: "conversation-1" })).toBe("/w/acme/activity?itemKind=chat&itemId=conversation-1");
    expect(buildCopilotDashboardLink("acme", { type: "quality_turn", id: "message-1" })).toBe("/w/acme/quality");
    expect(buildCopilotDashboardLink("acme", { type: "proposal", id: "proposal-1" })).toBe("/w/acme/copilot");
  });
});
