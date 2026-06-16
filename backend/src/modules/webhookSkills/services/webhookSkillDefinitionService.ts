import type {
  WebhookSkillDefinitionCreateInput,
  WebhookSkillDefinitionSummary,
  WebhookSkillDefinitionUpdateInput,
} from "../domain.js";
import { webhookSkillDefinitionCreateSchema, webhookSkillOutcomes } from "../domain.js";
import type {
  WebhookSkillDefinitionRecord,
  WebhookSkillDefinitionRepositoryPort,
} from "../../../db/repositories/webhookSkillDefinitionRepository.js";
import type { WebhookDestinationReferencePort } from "../../webhooks/public.js";
import { conflict, notFound } from "../../../shared/domain/errors.js";

export interface WebhookSkillDefinitionServiceOptions {
  repository: WebhookSkillDefinitionRepositoryPort;
  destinations: WebhookDestinationReferencePort;
}

const toSummary = (record: WebhookSkillDefinitionRecord): WebhookSkillDefinitionSummary => ({
  id: record.id,
  workspaceId: record.workspaceId,
  agentId: record.agentId,
  destinationId: record.destinationId,
  skillName: record.skillName,
  boundPayload: record.boundPayload,
  exposedPayload: record.exposedPayload,
  enabled: record.enabled,
  outcomes: [...webhookSkillOutcomes],
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

export class WebhookSkillDefinitionService {
  constructor(private readonly options: WebhookSkillDefinitionServiceOptions) {}

  async list(workspaceId: string, agentId: string): Promise<WebhookSkillDefinitionSummary[]> {
    return (await this.options.repository.listByAgent(workspaceId, agentId)).map(toSummary);
  }

  async create(
    workspaceId: string,
    agentId: string,
    input: WebhookSkillDefinitionCreateInput,
  ): Promise<WebhookSkillDefinitionSummary> {
    const destinationExists = await this.options.destinations.existsByIdAndWorkspace(workspaceId, input.destinationId);
    if (!destinationExists) {
      throw notFound("Webhook destination not found");
    }
    try {
      return toSummary(await this.options.repository.create({
        workspaceId,
        agentId,
        destinationId: input.destinationId,
        skillName: input.skillName,
        boundPayload: input.boundPayload,
        exposedPayload: input.exposedPayload,
        enabled: input.enabled,
      }));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw conflict(`A webhook skill named "${input.skillName}" already exists for this agent`);
      }
      throw error;
    }
  }

  async get(workspaceId: string, agentId: string, id: string): Promise<WebhookSkillDefinitionSummary> {
    const record = await this.options.repository.findById(workspaceId, agentId, id);
    if (!record) {
      throw notFound("Webhook skill definition not found");
    }
    return toSummary(record);
  }

  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    input: WebhookSkillDefinitionUpdateInput,
  ): Promise<WebhookSkillDefinitionSummary> {
    const existing = await this.options.repository.findById(workspaceId, agentId, id);
    if (!existing) {
      throw notFound("Webhook skill definition not found");
    }
    const merged = webhookSkillDefinitionCreateSchema.parse({
      skillName: existing.skillName,
      destinationId: existing.destinationId,
      boundPayload: input.boundPayload ?? existing.boundPayload,
      exposedPayload: input.exposedPayload ?? existing.exposedPayload,
      enabled: input.enabled ?? existing.enabled,
    });
    const updated = await this.options.repository.update(workspaceId, agentId, id, {
      boundPayload: merged.boundPayload,
      exposedPayload: merged.exposedPayload,
      enabled: merged.enabled,
    });
    if (!updated) {
      throw notFound("Webhook skill definition not found");
    }
    return toSummary(updated);
  }

  async remove(workspaceId: string, agentId: string, id: string): Promise<void> {
    const removed = await this.options.repository.remove(workspaceId, agentId, id);
    if (!removed) {
      throw notFound("Webhook skill definition not found");
    }
  }
}
