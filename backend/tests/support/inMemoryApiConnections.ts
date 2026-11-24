import { randomUUID } from "node:crypto";

import type {
  ApiConnectionRecord,
  ApiConnectionRepositoryPort,
  ApiConnectionWrite,
} from "../../src/modules/apiRequestSkills/public.js";
import type { SkillTargetUseReader } from "../../src/shared/domain/skillTargetUses.js";

const duplicateName = (): Error =>
  Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint: "idx_api_connections_workspace_lower_name",
  });

const inUse = (): Error =>
  Object.assign(new Error("API connection is referenced by agent skills"), {
    code: "23503",
    constraint: "agent_skills_api_request_target_fk",
  });

/**
 * API connections in memory, with the Postgres table's name index and delete guard: deleting a
 * connection a skill uses raises the same constraint the trigger raises.
 */
export class InMemoryApiConnectionRepository implements ApiConnectionRepositoryPort {
  readonly items = new Map<string, ApiConnectionRecord>();

  constructor(private readonly skillTargetUses: SkillTargetUseReader) {}

  async create(input: ApiConnectionWrite & { workspaceId: string }): Promise<ApiConnectionRecord> {
    this.assertNameFree(input.workspaceId, input.name, null);
    const now = new Date();
    const record: ApiConnectionRecord = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
    this.items.set(record.id, record);
    return { ...record };
  }

  async listByWorkspace(workspaceId: string): Promise<ApiConnectionRecord[]> {
    return [...this.items.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()))
      .map((record) => ({ ...record }));
  }

  async findByIdAndWorkspace(id: string, workspaceId: string): Promise<ApiConnectionRecord | null> {
    const record = this.items.get(id);
    return record && record.workspaceId === workspaceId ? { ...record } : null;
  }

  async update(id: string, workspaceId: string, input: ApiConnectionWrite): Promise<ApiConnectionRecord | null> {
    const existing = this.items.get(id);
    if (!existing || existing.workspaceId !== workspaceId) return null;
    this.assertNameFree(workspaceId, input.name, id);
    const record: ApiConnectionRecord = { ...existing, ...input, updatedAt: new Date() };
    this.items.set(id, record);
    return { ...record };
  }

  async delete(id: string, workspaceId: string): Promise<boolean> {
    const existing = this.items.get(id);
    if (!existing || existing.workspaceId !== workspaceId) return false;
    const uses = await this.skillTargetUses.listSkillTargetUses({ workspaceId, targetType: "api_connection", targetId: id });
    if (uses.length > 0) throw inUse();
    return this.items.delete(id);
  }

  private assertNameFree(workspaceId: string, name: string, exceptId: string | null): void {
    const taken = [...this.items.values()].some((record) =>
      record.workspaceId === workspaceId && record.id !== exceptId && record.name.toLowerCase() === name.toLowerCase());
    if (taken) throw duplicateName();
  }
}
