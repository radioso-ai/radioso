import { randomUUID } from "node:crypto";

import type {
  AgentSkillCreateRecord,
  AgentSkillRepositoryPort,
  AgentSkillUpdateRecord,
} from "../../src/modules/agentSkills/repository.js";
import type { AgentSkillSpine } from "../../src/modules/agentSkills/domain.js";
import { mergeSkillConfig } from "../../src/modules/agentSkills/configMerge.js";

const cloneConfig = (config: Record<string, unknown> = {}): Record<string, unknown> =>
  JSON.parse(JSON.stringify(config)) as Record<string, unknown>;

export class InMemoryAgentSkillRepository implements AgentSkillRepositoryPort {
  private readonly records = new Map<string, AgentSkillSpine>();

  async create(input: AgentSkillCreateRecord): Promise<AgentSkillSpine> {
    if ([...this.records.values()].some((record) =>
      record.agentId === input.agentId && record.skillName === input.skillName
    )) {
      const error = new Error("duplicate skill name") as Error & { code?: string };
      error.code = "23505";
      throw error;
    }
    if (
      input.invocationMode === "default_answer"
      && [...this.records.values()].some((record) =>
        record.agentId === input.agentId && record.invocationMode === "default_answer"
      )
    ) {
      const error = new Error("duplicate default answer") as Error & { code?: string };
      error.code = "23505";
      throw error;
    }
    const now = new Date();
    const record: AgentSkillSpine = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      skillName: input.skillName,
      kind: input.kind,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      config: cloneConfig(input.config),
      invocationMode: input.invocationMode,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return { ...record, config: cloneConfig(record.config) };
  }

  async findById(workspaceId: string, agentId: string, id: string): Promise<AgentSkillSpine | null> {
    const record = this.records.get(id);
    return record && record.workspaceId === workspaceId && record.agentId === agentId
      ? { ...record, config: cloneConfig(record.config) }
      : null;
  }

  async findByName(workspaceId: string, agentId: string, skillName: string): Promise<AgentSkillSpine | null> {
    const record = [...this.records.values()].find((candidate) =>
      candidate.workspaceId === workspaceId && candidate.agentId === agentId && candidate.skillName === skillName
    );
    return record ? { ...record, config: cloneConfig(record.config) } : null;
  }

  async findByAgentAndName(agentId: string, skillName: string): Promise<AgentSkillSpine | null> {
    const record = [...this.records.values()].find((candidate) =>
      candidate.agentId === agentId && candidate.skillName === skillName
    );
    return record ? { ...record, config: cloneConfig(record.config) } : null;
  }

  async findDefaultAnswer(workspaceId: string, agentId: string): Promise<AgentSkillSpine | null> {
    const record = [...this.records.values()].find((candidate) =>
      candidate.workspaceId === workspaceId
      && candidate.agentId === agentId
      && candidate.invocationMode === "default_answer"
    );
    return record ? { ...record, config: cloneConfig(record.config) } : null;
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<AgentSkillSpine[]> {
    return [...this.records.values()]
      .filter((record) => record.workspaceId === workspaceId && record.agentId === agentId)
      .sort((a, b) => a.skillName.localeCompare(b.skillName))
      .map((record) => ({ ...record, config: cloneConfig(record.config) }));
  }

  async listByWorkspace(workspaceId: string): Promise<AgentSkillSpine[]> {
    return [...this.records.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((a, b) => a.skillName.localeCompare(b.skillName))
      .map((record) => ({ ...record, config: cloneConfig(record.config) }));
  }

  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: AgentSkillUpdateRecord,
  ): Promise<AgentSkillSpine | null> {
    const existing = this.records.get(id);
    if (!existing || existing.workspaceId !== workspaceId || existing.agentId !== agentId) {
      return null;
    }
    if (input.expectedUpdatedAt && existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      return null;
    }
    if (
      input.invocationMode === "default_answer"
      && existing.invocationMode !== "default_answer"
      && [...this.records.values()].some((record) =>
        record.agentId === agentId && record.invocationMode === "default_answer"
      )
    ) {
      const error = new Error("duplicate default answer") as Error & { code?: string };
      error.code = "23505";
      throw error;
    }
    const updated: AgentSkillSpine = {
      ...existing,
      targetType: "targetType" in input ? input.targetType ?? null : existing.targetType,
      targetId: "targetId" in input ? input.targetId ?? null : existing.targetId,
      config: input.replaceConfig !== undefined
        ? cloneConfig(input.replaceConfig)
        : mergeSkillConfig(cloneConfig(existing.config), cloneConfig(input.config ?? {})),
      invocationMode: input.invocationMode ?? existing.invocationMode,
      enabled: "enabled" in input ? input.enabled ?? existing.enabled : existing.enabled,
      updatedAt: new Date(),
    };
    this.records.set(id, updated);
    return { ...updated, config: cloneConfig(updated.config) };
  }

  async remove(workspaceId: string, agentId: string, id: string): Promise<boolean> {
    const existing = this.records.get(id);
    if (!existing || existing.workspaceId !== workspaceId || existing.agentId !== agentId) {
      return false;
    }
    this.records.delete(id);
    return true;
  }

  async latestUpdatedAt(workspaceId: string, agentId: string): Promise<Date | null> {
    const timestamps = [...this.records.values()]
      .filter((record) => record.workspaceId === workspaceId && record.agentId === agentId)
      .map((record) => record.updatedAt.getTime());
    return timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null;
  }
}
