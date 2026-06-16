import { randomUUID } from "node:crypto";

import type {
  CreateWebhookSkillDefinitionInput,
  UpdateWebhookSkillDefinitionInput,
  WebhookSkillDefinitionRecord,
  WebhookSkillDefinitionRepositoryPort,
} from "../../src/db/repositories/webhookSkillDefinitionRepository.js";

const clone = (record: WebhookSkillDefinitionRecord): WebhookSkillDefinitionRecord => ({
  ...record,
  boundPayload: { ...record.boundPayload },
  exposedPayload: { ...record.exposedPayload },
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
});

export class InMemoryWebhookSkillDefinitionRepository implements WebhookSkillDefinitionRepositoryPort {
  private readonly rows = new Map<string, WebhookSkillDefinitionRecord>();

  async create(input: CreateWebhookSkillDefinitionInput): Promise<WebhookSkillDefinitionRecord> {
    if ([...this.rows.values()].some((row) => row.agentId === input.agentId && row.skillName === input.skillName)) {
      const error = new Error("duplicate key") as Error & { code: string };
      error.code = "23505";
      throw error;
    }
    const now = new Date();
    const record: WebhookSkillDefinitionRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      destinationId: input.destinationId,
      skillName: input.skillName,
      boundPayload: input.boundPayload ?? {},
      exposedPayload: input.exposedPayload ?? {},
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return clone(record);
  }

  async findById(workspaceId: string, agentId: string, id: string): Promise<WebhookSkillDefinitionRecord | null> {
    const record = this.rows.get(id);
    return record && record.workspaceId === workspaceId && record.agentId === agentId ? clone(record) : null;
  }

  async findEnabledByName(
    workspaceId: string,
    agentId: string,
    skillName: string,
  ): Promise<WebhookSkillDefinitionRecord | null> {
    const record = [...this.rows.values()].find((row) =>
      row.workspaceId === workspaceId && row.agentId === agentId && row.skillName === skillName && row.enabled
    );
    return record ? clone(record) : null;
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<WebhookSkillDefinitionRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === workspaceId && row.agentId === agentId)
      .sort((left, right) => left.skillName.localeCompare(right.skillName))
      .map(clone);
  }

  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: UpdateWebhookSkillDefinitionInput,
  ): Promise<WebhookSkillDefinitionRecord | null> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId || record.agentId !== agentId) {
      return null;
    }
    if (input.boundPayload !== undefined) record.boundPayload = input.boundPayload;
    if (input.exposedPayload !== undefined) record.exposedPayload = input.exposedPayload;
    if (input.enabled !== undefined) record.enabled = input.enabled;
    record.updatedAt = new Date();
    return clone(record);
  }

  async remove(workspaceId: string, agentId: string, id: string): Promise<boolean> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId || record.agentId !== agentId) {
      return false;
    }
    this.rows.delete(id);
    return true;
  }

  async countByDestination(workspaceId: string, destinationId: string): Promise<number> {
    return [...this.rows.values()].filter((row) =>
      row.destinationId === destinationId && (!workspaceId || row.workspaceId === workspaceId)
    ).length;
  }

  async listSkillNamesByDestination(workspaceId: string, destinationId: string): Promise<string[]> {
    return [...this.rows.values()]
      .filter((row) => row.destinationId === destinationId && row.workspaceId === workspaceId)
      .map((row) => row.skillName)
      .sort((left, right) => left.localeCompare(right));
  }
}
