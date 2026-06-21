import { randomUUID } from "node:crypto";

import type {
  CreateSlackSkillDefinitionInput,
  SlackSkillDefinitionRepositoryPort,
  SlackSkillDefinitionSummary,
  SlackSkillDefinitionUpdateInput,
} from "../../src/modules/slackSkills/public.js";

const clone = (record: SlackSkillDefinitionSummary): SlackSkillDefinitionSummary => ({
  ...record,
  boundInputs: { ...record.boundInputs },
  exposedInputs: { ...record.exposedInputs },
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
});

export class InMemorySlackSkillDefinitionRepository implements SlackSkillDefinitionRepositoryPort {
  private readonly rows = new Map<string, SlackSkillDefinitionSummary>();

  async create(input: CreateSlackSkillDefinitionInput): Promise<SlackSkillDefinitionSummary> {
    if ([...this.rows.values()].some((row) => row.agentId === input.agentId && row.skillName === input.skillName)) {
      const error = new Error("duplicate key") as Error & { code: string };
      error.code = "23505";
      throw error;
    }
    const now = new Date();
    const record: SlackSkillDefinitionSummary = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      installationId: input.installationId,
      skillName: input.skillName,
      boundInputs: input.boundInputs ?? {},
      exposedInputs: input.exposedInputs ?? {},
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return clone(record);
  }

  async findById(workspaceId: string, agentId: string, id: string): Promise<SlackSkillDefinitionSummary | null> {
    const record = this.rows.get(id);
    return record && record.workspaceId === workspaceId && record.agentId === agentId ? clone(record) : null;
  }

  async findEnabledByName(
    workspaceId: string,
    agentId: string,
    skillName: string,
  ): Promise<SlackSkillDefinitionSummary | null> {
    const record = [...this.rows.values()].find((row) =>
      row.workspaceId === workspaceId && row.agentId === agentId && row.skillName === skillName && row.enabled
    );
    return record ? clone(record) : null;
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<SlackSkillDefinitionSummary[]> {
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === workspaceId && row.agentId === agentId)
      .sort((left, right) => left.skillName.localeCompare(right.skillName))
      .map(clone);
  }

  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: SlackSkillDefinitionUpdateInput,
  ): Promise<SlackSkillDefinitionSummary | null> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId || record.agentId !== agentId) {
      return null;
    }
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
}
