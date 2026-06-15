import { badRequest, conflict, notFound } from "../../../shared/domain/errors.js";
import type {
  ExternalSkillDefinitionRecord,
  ExternalSkillDefinitionRepositoryPort,
} from "../../../db/repositories/externalSkillDefinitionRepository.js";
import { validateParamCoverage, type SkillDefinitionInput, type SkillDefinitionUpdateInput } from "../domain.js";
import type { McpConnectionService } from "./mcpConnectionService.js";

export interface ExternalSkillDefinitionView {
  id: string;
  connectionId: string;
  skillName: string;
  toolName: string;
  boundParams: Record<string, unknown>;
  exposedParams: Record<string, { slotBinding?: string }>;
  declaredOutcomes: string[] | null;
  outcomeMap: Record<string, string> | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const toView = (record: ExternalSkillDefinitionRecord): ExternalSkillDefinitionView => ({
  id: record.id,
  connectionId: record.connectionId,
  skillName: record.skillName,
  toolName: record.toolName,
  boundParams: record.boundParams,
  exposedParams: record.exposedParams,
  declaredOutcomes: record.declaredOutcomes,
  outcomeMap: record.outcomeMap,
  enabled: record.enabled,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

/**
 * Owns skill-definition authoring: validates a binding against the connection's
 * LIVE discovery (the bound tool must exist; bound/exposed params must cover the
 * tool's required inputs and reference real ones) before persisting.
 */
export class ExternalSkillDefinitionService {
  constructor(
    private readonly repository: ExternalSkillDefinitionRepositoryPort,
    private readonly connections: McpConnectionService,
  ) {}

  async create(agentId: string, input: SkillDefinitionInput): Promise<ExternalSkillDefinitionView> {
    // Verifies the connection exists for this agent (throws notFound otherwise).
    await this.connections.get(agentId, input.connectionId);

    const tools = await this.connections.discoverTools(agentId, input.connectionId);
    const tool = tools.find((candidate) => candidate.name === input.toolName);
    if (!tool) {
      throw badRequest(`Tool "${input.toolName}" was not found on the connection`);
    }

    const coverage = validateParamCoverage(
      tool.inputSchema,
      Object.keys(input.boundParams),
      Object.keys(input.exposedParams),
    );
    if (!coverage.ok) {
      throw badRequest("Skill params do not match the tool's input schema", coverage);
    }

    try {
      const record = await this.repository.create({
        agentId,
        connectionId: input.connectionId,
        skillName: input.skillName,
        toolName: input.toolName,
        boundParams: input.boundParams,
        exposedParams: input.exposedParams,
        declaredOutcomes: input.declaredOutcomes ?? null,
        outcomeMap: input.outcomeMap ?? null,
        enabled: input.enabled,
      });
      return toView(record);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw conflict(`A skill named "${input.skillName}" already exists for this agent`);
      }
      throw error;
    }
  }

  async list(agentId: string): Promise<ExternalSkillDefinitionView[]> {
    return (await this.repository.listByAgent(agentId)).map(toView);
  }

  async get(agentId: string, id: string): Promise<ExternalSkillDefinitionView> {
    const record = await this.repository.findById(agentId, id);
    if (!record) {
      throw notFound("Skill definition not found");
    }
    return toView(record);
  }

  /** Toggle enabled and/or update bindings; re-validates bindings against discovery. */
  async update(agentId: string, id: string, input: SkillDefinitionUpdateInput): Promise<ExternalSkillDefinitionView> {
    const existing = await this.repository.findById(agentId, id);
    if (!existing) {
      throw notFound("Skill definition not found");
    }

    if (input.boundParams !== undefined || input.exposedParams !== undefined) {
      const boundParams = input.boundParams ?? existing.boundParams;
      const exposedParams = input.exposedParams ?? existing.exposedParams;
      const tools = await this.connections.discoverTools(agentId, existing.connectionId);
      const tool = tools.find((candidate) => candidate.name === existing.toolName);
      if (!tool) {
        throw badRequest(`Tool "${existing.toolName}" was not found on the connection`);
      }
      const coverage = validateParamCoverage(tool.inputSchema, Object.keys(boundParams), Object.keys(exposedParams));
      if (!coverage.ok) {
        throw badRequest("Skill params do not match the tool's input schema", coverage);
      }
    }

    const updated = await this.repository.update(agentId, id, input);
    if (!updated) {
      throw notFound("Skill definition not found");
    }
    return toView(updated);
  }

  async remove(agentId: string, id: string): Promise<void> {
    const removed = await this.repository.remove(agentId, id);
    if (!removed) {
      throw notFound("Skill definition not found");
    }
  }
}
