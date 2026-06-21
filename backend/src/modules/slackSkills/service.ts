import type { SlackInstallationRepositoryPort } from "../slack/public.js";
import { conflict, notFound } from "../../shared/domain/errors.js";
import {
  slackSkillDefinitionCreateSchema,
  slackSkillOutcomes,
  type SlackSkillDefinitionCreateInput,
  type SlackSkillDefinitionSummary,
  type SlackSkillDefinitionUpdateInput,
} from "./domain.js";
import type { SlackSkillDefinitionRepositoryPort } from "./repository.js";

export interface SlackSkillDefinitionServiceOptions {
  repository: SlackSkillDefinitionRepositoryPort;
  installations: Pick<SlackInstallationRepositoryPort, "findById">;
}

const toSummary = (record: SlackSkillDefinitionSummary): SlackSkillDefinitionSummary => ({
  ...record,
  outcomes: [...slackSkillOutcomes],
  createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
  updatedAt: record.updatedAt instanceof Date ? record.updatedAt.toISOString() : record.updatedAt,
});

export class SlackSkillDefinitionService {
  constructor(private readonly options: SlackSkillDefinitionServiceOptions) {}

  async list(workspaceId: string, agentId: string): Promise<SlackSkillDefinitionSummary[]> {
    return (await this.options.repository.listByAgent(workspaceId, agentId)).map(toSummary);
  }

  async create(
    workspaceId: string,
    agentId: string,
    input: SlackSkillDefinitionCreateInput,
  ): Promise<SlackSkillDefinitionSummary> {
    const installation = await this.options.installations.findById(input.installationId);
    if (!installation || installation.workspaceId !== workspaceId) {
      throw notFound("Slack installation not found");
    }
    try {
      return toSummary(await this.options.repository.create({
        workspaceId,
        agentId,
        installationId: input.installationId,
        skillName: input.skillName,
        boundInputs: input.boundInputs,
        exposedInputs: input.exposedInputs,
        enabled: input.enabled,
      }));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw conflict(`A Slack skill named "${input.skillName}" already exists for this agent`);
      }
      throw error;
    }
  }

  async get(workspaceId: string, agentId: string, id: string): Promise<SlackSkillDefinitionSummary> {
    const record = await this.options.repository.findById(workspaceId, agentId, id);
    if (!record) {
      throw notFound("Slack skill definition not found");
    }
    return toSummary(record);
  }

  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: SlackSkillDefinitionUpdateInput,
  ): Promise<SlackSkillDefinitionSummary> {
    const existing = await this.options.repository.findById(workspaceId, agentId, id);
    if (!existing) {
      throw notFound("Slack skill definition not found");
    }
    const merged = slackSkillDefinitionCreateSchema.parse({
      skillName: existing.skillName,
      installationId: existing.installationId,
      boundInputs: input.boundInputs ?? existing.boundInputs,
      exposedInputs: input.exposedInputs ?? existing.exposedInputs,
      enabled: input.enabled ?? existing.enabled,
    });
    const updated = await this.options.repository.update(workspaceId, agentId, id, {
      boundInputs: merged.boundInputs,
      exposedInputs: merged.exposedInputs,
      enabled: merged.enabled,
    });
    if (!updated) {
      throw notFound("Slack skill definition not found");
    }
    return toSummary(updated);
  }

  async remove(workspaceId: string, agentId: string, id: string): Promise<void> {
    const removed = await this.options.repository.remove(workspaceId, agentId, id);
    if (!removed) {
      throw notFound("Slack skill definition not found");
    }
  }
}
