import { randomUUID } from "node:crypto";

import type {
  CreateIntegrationConnectionInput,
  IntegrationConnectionRecord,
  IntegrationConnectionRepositoryPort,
  UpdateIntegrationConnectionInput,
} from "../../src/modules/integrationConnections/public.js";

const clone = (record: IntegrationConnectionRecord): IntegrationConnectionRecord => ({
  ...record,
  config: { ...record.config },
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
  lastHealthCheckedAt: record.lastHealthCheckedAt ? new Date(record.lastHealthCheckedAt) : null,
});

export class InMemoryIntegrationConnectionRepository implements IntegrationConnectionRepositoryPort {
  private readonly rows = new Map<string, IntegrationConnectionRecord>();

  async create(input: CreateIntegrationConnectionInput): Promise<IntegrationConnectionRecord> {
    const now = new Date();
    const record: IntegrationConnectionRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      oauthConnectionId: input.oauthConnectionId,
      provider: input.provider,
      displayName: input.displayName,
      status: input.status ?? "authorized",
      lastHealthStatus: input.lastHealthStatus ?? null,
      lastHealthCheckedAt: input.lastHealthCheckedAt ?? null,
      lastErrorCode: input.lastErrorCode ?? null,
      config: { ...(input.config ?? {}) },
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return clone(record);
  }

  async findById(workspaceId: string, id: string): Promise<IntegrationConnectionRecord | null> {
    const record = this.rows.get(id);
    return record && record.workspaceId === workspaceId ? clone(record) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<IntegrationConnectionRecord[]> {
    return [...this.rows.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .map(clone);
  }

  async listByWorkspaceProvider(workspaceId: string, provider: string): Promise<IntegrationConnectionRecord[]> {
    return [...this.rows.values()]
      .filter((record) => record.workspaceId === workspaceId && record.provider === provider)
      .map(clone);
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateIntegrationConnectionInput,
  ): Promise<IntegrationConnectionRecord | null> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return null;
    }
    if (input.displayName !== undefined) record.displayName = input.displayName;
    if (input.status !== undefined) record.status = input.status;
    if (input.lastHealthStatus !== undefined) record.lastHealthStatus = input.lastHealthStatus;
    if (input.lastHealthCheckedAt !== undefined) record.lastHealthCheckedAt = input.lastHealthCheckedAt;
    if (input.lastErrorCode !== undefined) record.lastErrorCode = input.lastErrorCode;
    if (input.config !== undefined) record.config = { ...record.config, ...input.config };
    record.updatedAt = new Date();
    return clone(record);
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return false;
    }
    this.rows.delete(id);
    return true;
  }
}
