import { randomUUID } from "node:crypto";

import type {
  CreateEmailSkillDefinitionInput,
  EmailSkillDefinitionRecord,
  EmailSkillDefinitionRepositoryPort,
  UpdateEmailSkillDefinitionInput,
} from "../../src/db/repositories/emailSkillDefinitionRepository.js";

const clone = (record: EmailSkillDefinitionRecord): EmailSkillDefinitionRecord => ({
  ...record,
  boundInputs: { ...record.boundInputs },
  exposedInputs: { ...record.exposedInputs },
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
});

export class InMemoryEmailSkillDefinitionRepository implements EmailSkillDefinitionRepositoryPort {
  private readonly rows = new Map<string, EmailSkillDefinitionRecord>();

  async create(input: CreateEmailSkillDefinitionInput): Promise<EmailSkillDefinitionRecord> {
    if ([...this.rows.values()].some((row) => row.agentId === input.agentId && row.skillName === input.skillName)) {
      const error = new Error("duplicate key") as Error & { code: string };
      error.code = "23505";
      throw error;
    }
    const now = new Date();
    const record: EmailSkillDefinitionRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      connectionId: input.connectionId,
      skillName: input.skillName,
      mode: input.mode,
      boundInputs: input.boundInputs ?? {},
      exposedInputs: input.exposedInputs ?? {},
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return clone(record);
  }

  async findById(workspaceId: string, agentId: string, id: string): Promise<EmailSkillDefinitionRecord | null> {
    const record = this.rows.get(id);
    return record && record.workspaceId === workspaceId && record.agentId === agentId ? clone(record) : null;
  }

  async findEnabledByName(
    workspaceId: string,
    agentId: string,
    skillName: string,
  ): Promise<EmailSkillDefinitionRecord | null> {
    const record = [...this.rows.values()].find((row) =>
      row.workspaceId === workspaceId && row.agentId === agentId && row.skillName === skillName && row.enabled
    );
    return record ? clone(record) : null;
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<EmailSkillDefinitionRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === workspaceId && row.agentId === agentId)
      .sort((left, right) => left.skillName.localeCompare(right.skillName))
      .map(clone);
  }

  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: UpdateEmailSkillDefinitionInput,
  ): Promise<EmailSkillDefinitionRecord | null> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId || record.agentId !== agentId) {
      return null;
    }
    if (input.mode !== undefined) record.mode = input.mode;
    if (input.boundInputs !== undefined) record.boundInputs = input.boundInputs;
    if (input.exposedInputs !== undefined) record.exposedInputs = input.exposedInputs;
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

  async countByConnection(workspaceId: string, connectionId: string): Promise<number> {
    return [...this.rows.values()].filter((row) =>
      row.connectionId === connectionId && (!workspaceId || row.workspaceId === workspaceId)
    ).length;
  }
}
