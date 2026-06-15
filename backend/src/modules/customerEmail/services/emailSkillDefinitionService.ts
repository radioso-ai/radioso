import type {
  CustomerEmailSkillDefinitionCreateInput,
  CustomerEmailSkillDefinitionSummary,
  CustomerEmailSkillDefinitionUpdateInput,
} from "../domain.js";
import { customerEmailSkillDefinitionCreateSchema, customerEmailSkillOutcomes } from "../domain.js";
import type {
  EmailSkillDefinitionRecord,
  EmailSkillDefinitionRepositoryPort,
} from "../../../db/repositories/emailSkillDefinitionRepository.js";
import type { CustomerEmailConnectionRepositoryPort } from "../../../db/repositories/customerEmailConnectionRepository.js";
import { conflict, notFound } from "../../../shared/domain/errors.js";

export interface EmailSkillDefinitionServiceOptions {
  repository: EmailSkillDefinitionRepositoryPort;
  connections: Pick<CustomerEmailConnectionRepositoryPort, "findById">;
}

const toSummary = (record: EmailSkillDefinitionRecord): CustomerEmailSkillDefinitionSummary => ({
  id: record.id,
  workspaceId: record.workspaceId,
  agentId: record.agentId,
  connectionId: record.connectionId,
  skillName: record.skillName,
  mode: record.mode,
  boundInputs: record.boundInputs,
  exposedInputs: record.exposedInputs,
  enabled: record.enabled,
  outcomes: [...customerEmailSkillOutcomes],
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

export class EmailSkillDefinitionService {
  constructor(private readonly options: EmailSkillDefinitionServiceOptions) {}

  async list(workspaceId: string, agentId: string): Promise<CustomerEmailSkillDefinitionSummary[]> {
    return (await this.options.repository.listByAgent(workspaceId, agentId)).map(toSummary);
  }

  async create(
    workspaceId: string,
    agentId: string,
    input: CustomerEmailSkillDefinitionCreateInput,
  ): Promise<CustomerEmailSkillDefinitionSummary> {
    const connection = await this.options.connections.findById(workspaceId, input.connectionId);
    if (!connection) {
      throw notFound("Customer email connection not found");
    }
    try {
      return toSummary(await this.options.repository.create({
        workspaceId,
        agentId,
        connectionId: input.connectionId,
        skillName: input.skillName,
        mode: input.mode,
        boundInputs: input.boundInputs,
        exposedInputs: input.exposedInputs,
        enabled: input.enabled,
      }));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw conflict(`An email skill named "${input.skillName}" already exists for this agent`);
      }
      throw error;
    }
  }

  async get(workspaceId: string, agentId: string, id: string): Promise<CustomerEmailSkillDefinitionSummary> {
    const record = await this.options.repository.findById(workspaceId, agentId, id);
    if (!record) {
      throw notFound("Email skill definition not found");
    }
    return toSummary(record);
  }

  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: CustomerEmailSkillDefinitionUpdateInput,
  ): Promise<CustomerEmailSkillDefinitionSummary> {
    const existing = await this.options.repository.findById(workspaceId, agentId, id);
    if (!existing) {
      throw notFound("Email skill definition not found");
    }
    const merged = customerEmailSkillDefinitionCreateSchema.parse({
      skillName: existing.skillName,
      connectionId: existing.connectionId,
      mode: input.mode ?? existing.mode,
      boundInputs: input.boundInputs ?? existing.boundInputs,
      exposedInputs: input.exposedInputs ?? existing.exposedInputs,
      enabled: input.enabled ?? existing.enabled,
    });
    const updated = await this.options.repository.update(workspaceId, agentId, id, {
      mode: merged.mode,
      boundInputs: merged.boundInputs,
      exposedInputs: merged.exposedInputs,
      enabled: merged.enabled,
    });
    if (!updated) {
      throw notFound("Email skill definition not found");
    }
    return toSummary(updated);
  }

  async remove(workspaceId: string, agentId: string, id: string): Promise<void> {
    const removed = await this.options.repository.remove(workspaceId, agentId, id);
    if (!removed) {
      throw notFound("Email skill definition not found");
    }
  }
}
