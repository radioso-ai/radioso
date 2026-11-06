import { randomUUID } from "node:crypto";

import type {
  CreateMcpConnectionInput,
  McpConnectionAgentUsage,
  McpConnectionRecord,
  McpConnectionRepositoryPort,
  UpdateMcpConnectionInput,
} from "../../src/db/repositories/mcpConnectionRepository.js";
import type {
  CreateExternalSkillDefinitionInput,
  ExternalSkillDefinitionRecord,
  ExternalSkillDefinitionRepositoryPort,
  UpdateExternalSkillDefinitionInput,
} from "../../src/db/repositories/externalSkillDefinitionRepository.js";
import type { ToolServiceFactory } from "../../src/modules/externalSkills/executor/mcpSkillExecutor.js";
import { SdkMcpToolService } from "../../src/modules/externalSkills/toolService/sdkMcpToolService.js";
import { connectMockMcpServer, type MockTool } from "./mockMcpServer.js";

export class InMemoryMcpConnectionRepository implements McpConnectionRepositoryPort {
  private readonly rows = new Map<string, McpConnectionRecord>();
  private referenceChecker?: (connectionId: string) => boolean;
  private agentUsageLookup?: (workspaceId: string, connectionId?: string) => Promise<McpConnectionAgentUsage[]>;

  /** Model the real ON DELETE RESTRICT: throw 23503 if a skill references it. */
  setReferenceChecker(checker: (connectionId: string) => boolean): void {
    this.referenceChecker = checker;
  }

  setAgentUsageLookup(lookup: (workspaceId: string, connectionId?: string) => Promise<McpConnectionAgentUsage[]>): void {
    this.agentUsageLookup = lookup;
  }

  async listAgentUsage(workspaceId: string, connectionId?: string): Promise<McpConnectionAgentUsage[]> {
    return (await this.agentUsageLookup?.(workspaceId, connectionId)) ?? [];
  }

  async create(input: CreateMcpConnectionInput): Promise<McpConnectionRecord> {
    const now = new Date();
    const record: McpConnectionRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      displayName: input.displayName,
      serverUrl: input.serverUrl,
      authMethod: input.authMethod,
      credentialCiphertext: input.credentialCiphertext ?? null,
      oauthClientCiphertext: input.oauthClientCiphertext ?? null,
      oauthFlowCiphertext: null,
      status: input.status ?? "unconfigured",
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return { ...record };
  }

  async findById(workspaceId: string, id: string): Promise<McpConnectionRecord | null> {
    const record = this.rows.get(id);
    return record && record.workspaceId === workspaceId ? { ...record } : null;
  }

  async listByWorkspace(workspaceId: string): Promise<McpConnectionRecord[]> {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId).map((row) => ({ ...row }));
  }

  async listUsedByAgent(workspaceId: string, agentId: string): Promise<McpConnectionRecord[]> {
    const usage = await this.listAgentUsage(workspaceId);
    const used = new Set(usage.filter((row) => row.agentId === agentId).map((row) => row.connectionId));
    return [...this.rows.values()].filter((row) => used.has(row.id)).map((row) => ({ ...row }));
  }

  async updateStatus(workspaceId: string, id: string, status: McpConnectionRecord["status"]): Promise<McpConnectionRecord | null> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return null;
    }
    record.status = status;
    record.updatedAt = new Date();
    return { ...record };
  }

  async update(workspaceId: string, id: string, input: UpdateMcpConnectionInput): Promise<McpConnectionRecord | null> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return null;
    }
    if (input.displayName !== undefined) record.displayName = input.displayName;
    if (input.credentialCiphertext !== undefined) record.credentialCiphertext = input.credentialCiphertext;
    if (input.status !== undefined) record.status = input.status;
    record.updatedAt = new Date();
    return { ...record };
  }

  async setOauthFlow(workspaceId: string, id: string, oauthFlowCiphertext: string): Promise<McpConnectionRecord | null> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return null;
    }
    record.oauthFlowCiphertext = oauthFlowCiphertext;
    record.updatedAt = new Date();
    return { ...record };
  }

  async setOauthTokens(
    workspaceId: string,
    id: string,
    credentialCiphertext: string,
  ): Promise<McpConnectionRecord | null> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return null;
    }
    record.credentialCiphertext = credentialCiphertext;
    record.oauthFlowCiphertext = null;
    record.status = "authorized";
    record.updatedAt = new Date();
    return { ...record };
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return false;
    }
    if (this.referenceChecker?.(id)) {
      throw Object.assign(new Error("connection is still referenced"), { code: "23503" });
    }
    this.rows.delete(id);
    return true;
  }
}

export class InMemoryExternalSkillDefinitionRepository implements ExternalSkillDefinitionRepositoryPort {
  private readonly rows = new Map<string, ExternalSkillDefinitionRecord>();

  hasConnectionReference(connectionId: string): boolean {
    return [...this.rows.values()].some((row) => row.connectionId === connectionId);
  }

  /** Each agent and connection pair in the workspace, once, however many skills join them. */
  connectionUsage(workspaceId: string, connectionId?: string): Array<{ connectionId: string; agentId: string }> {
    const pairs = [...this.rows.values()]
      .filter((row) => row.workspaceId === workspaceId && (connectionId === undefined || row.connectionId === connectionId))
      .map((row) => ({ connectionId: row.connectionId, agentId: row.agentId }));
    return [...new Map(pairs.map((pair) => [`${pair.connectionId}:${pair.agentId}`, pair])).values()];
  }

  async create(input: CreateExternalSkillDefinitionInput): Promise<ExternalSkillDefinitionRecord> {
    const duplicate = [...this.rows.values()].some(
      (row) => row.agentId === input.agentId && row.skillName === input.skillName,
    );
    if (duplicate) {
      throw Object.assign(new Error("duplicate skill name"), { code: "23505" });
    }
    const now = new Date();
    const record: ExternalSkillDefinitionRecord = {
      id: randomUUID(),
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      skillName: input.skillName,
      toolName: input.toolName,
      boundParams: input.boundParams,
      exposedParams: input.exposedParams,
      declaredOutcomes: input.declaredOutcomes ?? null,
      outcomeMap: input.outcomeMap ?? null,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return { ...record };
  }

  async findById(agentId: string, id: string): Promise<ExternalSkillDefinitionRecord | null> {
    const record = this.rows.get(id);
    return record && record.agentId === agentId ? { ...record } : null;
  }

  async findEnabledByName(agentId: string, skillName: string): Promise<ExternalSkillDefinitionRecord | null> {
    const record = [...this.rows.values()].find(
      (row) => row.agentId === agentId && row.skillName === skillName && row.enabled,
    );
    return record ? { ...record } : null;
  }

  async listByAgent(agentId: string): Promise<ExternalSkillDefinitionRecord[]> {
    return [...this.rows.values()].filter((row) => row.agentId === agentId).map((row) => ({ ...row }));
  }

  async listByConnection(agentId: string, connectionId: string): Promise<ExternalSkillDefinitionRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.agentId === agentId && row.connectionId === connectionId)
      .map((row) => ({ ...row }));
  }

  async update(
    agentId: string,
    id: string,
    input: UpdateExternalSkillDefinitionInput,
  ): Promise<ExternalSkillDefinitionRecord | null> {
    const record = this.rows.get(id);
    if (!record || record.agentId !== agentId) {
      return null;
    }
    if (input.boundParams !== undefined) record.boundParams = input.boundParams;
    if (input.exposedParams !== undefined) record.exposedParams = input.exposedParams;
    if (input.declaredOutcomes !== undefined) record.declaredOutcomes = input.declaredOutcomes;
    if (input.enabled !== undefined) record.enabled = input.enabled;
    record.updatedAt = new Date();
    return { ...record };
  }

  async remove(agentId: string, id: string): Promise<boolean> {
    const record = this.rows.get(id);
    if (!record || record.agentId !== agentId) {
      return false;
    }
    this.rows.delete(id);
    return true;
  }
}

const DEFAULT_TOOLS: MockTool[] = [
  {
    name: "post_message",
    description: "Post a message to a channel",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string" }, message: { type: "string" } },
      required: ["channel", "message"],
    },
    respond: (args) => ({ content: [{ type: "text", text: "posted" }], structuredContent: { ok: true, echoed: args } }),
  },
];

/** ToolService factory backed by an in-process mock MCP server (no network). */
export const createMockToolServiceFactory = (tools: MockTool[] = DEFAULT_TOOLS): ToolServiceFactory => ({
  create: () =>
    new SdkMcpToolService({ transportFactory: async () => (await connectMockMcpServer(tools)).clientTransport }),
});
