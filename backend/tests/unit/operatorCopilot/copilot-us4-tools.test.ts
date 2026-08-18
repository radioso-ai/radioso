import { describe, expect, it, vi } from "vitest";

import { createUs4CopilotTools } from "../../../src/modules/operatorCopilot/tools.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  pageContext: { view: "documents" as const, agentId: "agent-1", conversationId: null, selection: null, entities: [] },
};

const documentStatusPorts = () => {
  const summarizeWorkspace = vi.fn(async () => ({
    documentCount: 12,
    readyDocumentCount: 9,
    pendingDocumentCount: 2,
    failedDocumentCount: 1,
    sampleDocumentCount: 0,
    sampleDocumentSlugs: [],
  }));
  const listByStatuses = vi.fn(async () => [
    {
      id: "document-1",
      title: "Refund policy",
      status: "failed",
      ragStatus: "pending" as const,
      failureReason: "Parser timed out",
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
      updatedAt: new Date("2026-08-02T10:00:00.000Z"),
      metadata: { customerEmail: "person@example.com" },
      sourceId: "source-1",
      sourceKind: "inline_text" as const,
      retrievalEnabled: true,
      retrievalExpiresAt: null,
    },
  ]);
  const listByWorkspaceIdWithDocumentCounts = vi.fn(async () => [
    {
      id: "source-1",
      kind: "website" as const,
      name: "Help center",
      lastSyncStatus: "failed",
      lastSyncedAt: new Date("2026-08-02T09:00:00.000Z"),
      documentCount: 4,
      config: { crawlerApiKey: "sk-secret-value" },
      metadata: { seedUrl: "https://help.example.com" },
    },
  ]);
  return { summarizeWorkspace, listByStatuses, listByWorkspaceIdWithDocumentCounts };
};

const agentSkillPorts = () => {
  const get = vi.fn(async (_workspaceId: string, agentId: string) => ({ id: agentId, name: "Support" }) as never);
  const list = vi.fn(async () => [
    {
      id: "skill-1",
      name: "notify_ops",
      capability: "notify",
      target: { kind: "webhook_destination", id: "target-1" },
      config: { boundPayload: { customerEmail: "person@example.com" }, delivery: { token: "shhh-secret" } },
      invocationMode: "routine_named",
      enabled: true,
    },
  ]);
  const registryList = vi.fn(() => [
    {
      id: "notify",
      targetKind: "webhook_destination",
      requiresTarget: true,
      enumerateTargets: vi.fn(async () => [{ id: "target-1", label: "Ops webhook", status: "active" }]),
    },
    {
      id: "mcp_tool",
      targetKind: "mcp_connection",
      requiresTarget: true,
      enumerateTargets: vi.fn(async () => []),
    },
    {
      id: "retrieve",
      targetKind: "workspace",
      requiresTarget: false,
      enumerateTargets: vi.fn(async () => []),
    },
  ]);
  return { get, list, registryList };
};

const buildDescriptors = (
  documents = documentStatusPorts(),
  skills = agentSkillPorts(),
) =>
  createUs4CopilotTools({
    agentService: { get: skills.get },
    documentStatusService: {
      summarizeWorkspace: documents.summarizeWorkspace,
      listByStatuses: documents.listByStatuses,
    },
    documentSourceStatusService: {
      listByWorkspaceIdWithDocumentCounts: documents.listByWorkspaceIdWithDocumentCounts,
    },
    agentSkillsService: { list: skills.list },
    skillCapabilityRegistry: { list: skills.registryList },
  });

describe("US4 copilot readers", () => {
  it("declares the document status and agent skills readers with their required permissions", () => {
    const descriptors = buildDescriptors();

    expect(descriptors.map(({ name, requiredPermission, contributingModule, uiLabel, shape }) => ({ name, requiredPermission, contributingModule, uiLabel, shape }))).toEqual([
      {
        name: "document_status",
        requiredPermission: "workspace.documents.read",
        contributingModule: "documents",
        uiLabel: "Checking document status",
        shape: "read",
      },
      {
        name: "agent_skills",
        requiredPermission: "workspace.agents.read",
        contributingModule: "agentSkills",
        uiLabel: "Reading agent skills",
        shape: "read",
      },
    ]);
  });

  describe("document_status", () => {
    it("reports workspace ingestion counts, the attention list, and source sync state", async () => {
      const documents = documentStatusPorts();
      const descriptors = buildDescriptors(documents);

      const result = await descriptors[0].createTool(context).invoke({}, {} as never) as {
        counts: Record<string, number>;
        attention: Array<Record<string, unknown>>;
        sources: Array<Record<string, unknown>>;
      };

      expect(documents.summarizeWorkspace).toHaveBeenCalledWith("workspace-1");
      expect(documents.listByStatuses).toHaveBeenCalledWith("workspace-1", ["failed", "queued", "processing"], { limit: 25 });
      expect(documents.listByWorkspaceIdWithDocumentCounts).toHaveBeenCalledWith("workspace-1");
      expect(result.counts).toEqual({ total: 12, ready: 9, pending: 2, failed: 1 });
      expect(result.attention).toEqual([
        {
          id: "document-1",
          title: "Refund policy",
          status: "failed",
          failureReason: "Parser timed out",
          updatedAt: "2026-08-02T10:00:00.000Z",
          sourceId: "source-1",
        },
      ]);
      expect(result.sources).toEqual([
        {
          id: "source-1",
          kind: "website",
          label: "Help center",
          lastSyncStatus: "failed",
          lastSyncedAt: "2026-08-02T09:00:00.000Z",
          documentCount: 4,
        },
      ]);
    });

    it("never emits document content, metadata values, or source credentials", async () => {
      const descriptors = buildDescriptors();
      const serialized = JSON.stringify(await descriptors[0].createTool(context).invoke({}, {} as never));

      expect(serialized).not.toContain("person@example.com");
      expect(serialized).not.toContain("sk-secret-value");
      expect(serialized).not.toContain("metadata");
      expect(serialized).not.toContain("config");
    });

    it("is workspace scoped, so it links no single entity", () => {
      expect(buildDescriptors()[0].describeEntity).toBeUndefined();
    });
  });

  describe("agent_skills", () => {
    it("joins configured skills to their capability targets and reports capability availability", async () => {
      const skills = agentSkillPorts();
      const descriptors = buildDescriptors(documentStatusPorts(), skills);

      const result = await descriptors[1].createTool(context).invoke({}, {} as never) as {
        skills: Array<Record<string, unknown>>;
        capabilities: Array<Record<string, unknown>>;
      };

      expect(skills.get).toHaveBeenCalledWith("workspace-1", "agent-1");
      expect(skills.list).toHaveBeenCalledWith("workspace-1", "agent-1");
      expect(result.skills).toEqual([
        {
          name: "notify_ops",
          capability: "notify",
          invocationMode: "routine_named",
          enabled: true,
          target: { kind: "webhook_destination", id: "target-1", label: "Ops webhook", status: "active" },
          configKeys: ["boundPayload", "delivery"],
        },
      ]);
      expect(result.capabilities).toEqual([
        { id: "notify", targetKind: "webhook_destination", requiresTarget: true, targetCount: 1, available: true, unavailableReason: null },
        { id: "mcp_tool", targetKind: "mcp_connection", requiresTarget: true, targetCount: 0, available: false, unavailableReason: "no_connection" },
        { id: "retrieve", targetKind: "workspace", requiresTarget: false, targetCount: 0, available: true, unavailableReason: null },
      ]);
    });

    it("emits skill config key names only, never config values", async () => {
      const descriptors = buildDescriptors();
      const serialized = JSON.stringify(await descriptors[1].createTool(context).invoke({}, {} as never));

      expect(serialized).toContain("boundPayload");
      expect(serialized).not.toContain("person@example.com");
      expect(serialized).not.toContain("shhh-secret");
    });

    it("proves the agent belongs to the workspace before enumerating agent-scoped targets", async () => {
      const skills = agentSkillPorts();
      skills.get.mockRejectedValueOnce(new Error("Agent not found"));
      const descriptors = buildDescriptors(documentStatusPorts(), skills);

      await expect(descriptors[1].createTool(context).invoke({ agentId: "agent-9" }, {} as never)).rejects.toThrow("Agent not found");

      expect(skills.get).toHaveBeenCalledWith("workspace-1", "agent-9");
      expect(skills.list).not.toHaveBeenCalled();
      for (const descriptor of skills.registryList.mock.results.flatMap((entry) => entry.value ?? [])) {
        expect(descriptor.enumerateTargets).not.toHaveBeenCalled();
      }
    });

    it("falls back to the page context agent and links the agent entity", async () => {
      const skills = agentSkillPorts();
      const descriptors = buildDescriptors(documentStatusPorts(), skills);

      await descriptors[1].createTool(context).invoke({}, {} as never);

      expect(skills.list).toHaveBeenCalledWith("workspace-1", "agent-1");
      expect(descriptors[1].describeEntity?.({}, context)).toEqual({ type: "agent", id: "agent-1" });
      expect(descriptors[1].describeEntity?.({ agentId: "agent-7" }, context)).toEqual({ type: "agent", id: "agent-7" });
    });
  });
});
