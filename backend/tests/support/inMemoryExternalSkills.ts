import { randomUUID } from "node:crypto";

import type {
  CreateMcpConnectionInput,
  McpConnectionRecord,
  McpConnectionRepositoryPort,
} from "../../src/db/repositories/mcpConnectionRepository.js";
import type {
  CreateExternalSkillDefinitionInput,
  ExternalSkillDefinitionRecord,
  ExternalSkillDefinitionRepositoryPort,
} from "../../src/db/repositories/externalSkillDefinitionRepository.js";
import type { ToolServiceFactory } from "../../src/modules/externalSkills/executor/mcpSkillExecutor.js";
import { SdkMcpToolService } from "../../src/modules/externalSkills/toolService/sdkMcpToolService.js";
import { connectMockMcpServer, type MockTool } from "./mockMcpServer.js";

export class InMemoryMcpConnectionRepository implements McpConnectionRepositoryPort {
  private readonly rows = new Map<string, McpConnectionRecord>();

  async create(input: CreateMcpConnectionInput): Promise<McpConnectionRecord> {
    const now = new Date();
    const record: McpConnectionRecord = {
      id: randomUUID(),
      agentId: input.agentId,
      displayName: input.displayName,
      serverUrl: input.serverUrl,
      authMethod: input.authMethod,
      credentialCiphertext: input.credentialCiphertext ?? null,
      encryptionKeyId: input.encryptionKeyId ?? null,
      oauthClientCiphertext: null,
      status: input.status ?? "unconfigured",
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return { ...record };
  }

  async findById(agentId: string, id: string): Promise<McpConnectionRecord | null> {
    const record = this.rows.get(id);
    return record && record.agentId === agentId ? { ...record } : null;
  }

  async listByAgent(agentId: string): Promise<McpConnectionRecord[]> {
    return [...this.rows.values()].filter((row) => row.agentId === agentId).map((row) => ({ ...row }));
  }

  async updateStatus(agentId: string, id: string, status: McpConnectionRecord["status"]): Promise<McpConnectionRecord | null> {
    const record = this.rows.get(id);
    if (!record || record.agentId !== agentId) {
      return null;
    }
    record.status = status;
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

export class InMemoryExternalSkillDefinitionRepository implements ExternalSkillDefinitionRepositoryPort {
  private readonly rows = new Map<string, ExternalSkillDefinitionRecord>();

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
