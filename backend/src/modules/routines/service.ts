import { randomUUID } from "node:crypto";

import { badRequest, notFound } from "../../shared/domain/errors.js";
import {
  routineDefinitionDraftInputSchema,
  type RoutineDefinition,
  type RoutineDefinitionDraftInput,
} from "./domain.js";
import { compileRoutineDefinition } from "./compiler.js";
import { validateRoutineDefinition, type RoutineValidationResult } from "./validator.js";

export interface RoutineDefinitionRepositoryPort {
  listByAgent(agentId: string): Promise<RoutineDefinition[]>;
  findById(agentId: string, id: string): Promise<RoutineDefinition | null>;
  createDraft(agentId: string, input: RoutineDefinitionDraftInput): Promise<RoutineDefinition>;
  updateDraft(agentId: string, id: string, input: RoutineDefinitionDraftInput): Promise<RoutineDefinition>;
  publish(agentId: string, id: string): Promise<RoutineDefinition>;
  deleteDraft(agentId: string, id: string): Promise<boolean>;
}

export interface RoutineDefinitionSaveResult {
  routine: RoutineDefinition;
  validation: RoutineValidationResult;
}

export interface RoutineDefinitionPublishRejection {
  rejected: true;
  validation: RoutineValidationResult;
}

export type RoutineDefinitionPublishResult = RoutineDefinitionSaveResult | RoutineDefinitionPublishRejection;

export interface RoutineDefinitionServiceOptions {
  agentRepository: {
    findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<unknown | null>;
  };
  repository: RoutineDefinitionRepositoryPort;
}

const draftDefinitionFromInput = (agentId: string, input: RoutineDefinitionDraftInput): RoutineDefinition => ({
  id: randomUUID(),
  agentId,
  version: 1,
  status: "draft",
  ...input,
  createdAt: new Date(),
  updatedAt: new Date(),
});

export class RoutineDefinitionService {
  constructor(private readonly options: RoutineDefinitionServiceOptions) {}

  async list(workspaceId: string, agentId: string): Promise<RoutineDefinition[]> {
    await this.requireAgent(workspaceId, agentId);
    return this.options.repository.listByAgent(agentId);
  }

  async get(workspaceId: string, agentId: string, id: string): Promise<RoutineDefinition> {
    await this.requireAgent(workspaceId, agentId);
    return this.requireRoutine(agentId, id);
  }

  async createDraft(
    workspaceId: string,
    agentId: string,
    input: RoutineDefinitionDraftInput,
  ): Promise<RoutineDefinitionSaveResult> {
    await this.requireAgent(workspaceId, agentId);
    const draft = this.validateInput(input);
    const saved = await this.options.repository.createDraft(agentId, draft);
    return {
      routine: saved,
      validation: validateRoutineDefinition(saved),
    };
  }

  async updateDraft(
    workspaceId: string,
    agentId: string,
    id: string,
    input: RoutineDefinitionDraftInput,
  ): Promise<RoutineDefinitionSaveResult> {
    await this.requireAgent(workspaceId, agentId);
    const existing = await this.requireRoutine(agentId, id);
    if (existing.status !== "draft") {
      throw badRequest("Only draft routine definitions can be updated");
    }
    const draft = this.validateInput(input);
    const saved = await this.options.repository.updateDraft(agentId, id, draft);
    return {
      routine: saved,
      validation: validateRoutineDefinition(saved),
    };
  }

  async validate(
    workspaceId: string,
    agentId: string,
    target: { id: string } | { input: RoutineDefinitionDraftInput },
  ): Promise<RoutineValidationResult> {
    await this.requireAgent(workspaceId, agentId);
    if ("id" in target) {
      const routine = await this.requireRoutine(agentId, target.id);
      return validateRoutineDefinition(routine);
    }
    const draft = this.validateInput(target.input);
    return validateRoutineDefinition(draftDefinitionFromInput(agentId, draft));
  }

  async publish(workspaceId: string, agentId: string, id: string): Promise<RoutineDefinitionPublishResult> {
    await this.requireAgent(workspaceId, agentId);
    const routine = await this.requireRoutine(agentId, id);
    if (routine.status !== "draft") {
      throw badRequest("Only draft routine definitions can be published");
    }
    const validation = validateRoutineDefinition(routine);
    if (!validation.ok) {
      return { rejected: true, validation };
    }
    compileRoutineDefinition(routine);
    const published = await this.options.repository.publish(agentId, id);
    return {
      routine: published,
      validation: validateRoutineDefinition(published),
    };
  }

  async deleteDraft(workspaceId: string, agentId: string, id: string): Promise<void> {
    await this.requireAgent(workspaceId, agentId);
    const deleted = await this.options.repository.deleteDraft(agentId, id);
    if (!deleted) {
      throw notFound("Draft routine definition not found");
    }
  }

  private validateInput(input: RoutineDefinitionDraftInput): RoutineDefinitionDraftInput {
    const parsed = routineDefinitionDraftInputSchema.safeParse(input);
    if (!parsed.success) {
      throw badRequest("Invalid routine definition input", parsed.error.flatten());
    }
    return parsed.data;
  }

  private async requireAgent(workspaceId: string, agentId: string): Promise<void> {
    const agent = await this.options.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      throw notFound("Agent not found");
    }
  }

  private async requireRoutine(agentId: string, id: string): Promise<RoutineDefinition> {
    const routine = await this.options.repository.findById(agentId, id);
    if (!routine) {
      throw notFound("Routine definition not found");
    }
    return routine;
  }
}
