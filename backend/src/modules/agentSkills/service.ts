import { z } from "zod";

import { badRequest, conflict, notFound } from "../../shared/domain/errors.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import {
  skillCapabilityIdSchema,
  type SkillCapabilityDescriptor,
  type SkillCapabilityId,
  type SkillCapabilityRegistry,
} from "../skills/public.js";
import { agentSkillInvocationModes, type AgentSkillInvocationMode, type AgentSkillSpine } from "./domain.js";
import type { AgentSkillRepositoryPort } from "./repository.js";

const skillNamePattern = /^[a-z][a-z0-9_]*$/u;
const skillNamePatternMessage = "must start with a lowercase letter and contain only lowercase letters, numbers, and underscores";

const targetSchema = z.object({
  kind: z.string().trim().min(1),
  id: z.string().uuid().nullable(),
}).strict();

export const agentSkillCreateSchema = z.object({
  name: z.string().trim().min(1).max(120).regex(skillNamePattern, skillNamePatternMessage),
  capability: skillCapabilityIdSchema,
  target: targetSchema,
  config: z.record(z.unknown()).default({}),
  invocationMode: z.enum(agentSkillInvocationModes).default("routine_named"),
  enabled: z.boolean().default(true),
}).strict();

export type AgentSkillCreateInput = z.infer<typeof agentSkillCreateSchema>;

export const agentSkillUpdateSchema = z.object({
  target: targetSchema.optional(),
  config: z.record(z.unknown()).optional(),
  replaceConfig: z.record(z.unknown()).optional(),
  invocationMode: z.enum(agentSkillInvocationModes).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((input) => Object.keys(input).length > 0, {
  message: "At least one field must be provided",
}).refine((input) => !(input.config && input.replaceConfig), {
  message: "config and replaceConfig cannot both be provided",
});

export type AgentSkillUpdateInput = z.infer<typeof agentSkillUpdateSchema>;

export interface AgentSkillView {
  id: string;
  workspaceId: string;
  agentId: string;
  name: string;
  capability: SkillCapabilityId;
  storedKind: string;
  target: {
    kind: string | null;
    id: string | null;
  };
  config: Record<string, unknown>;
  invocationMode: AgentSkillInvocationMode;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSkillsServiceOptions {
  repository: AgentSkillRepositoryPort;
  capabilities: SkillCapabilityRegistry;
  logger?: AppLogger;
}

const pgErrorMeta = (error: unknown): { code?: string; constraint?: string } => {
  if (!error || typeof error !== "object") {
    return {};
  }
  const candidate = error as { code?: unknown; constraint?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : undefined,
    constraint: typeof candidate.constraint === "string" ? candidate.constraint : undefined,
  };
};

const isUniqueViolation = (error: unknown): boolean => pgErrorMeta(error).code === "23505";

// The agent_skills target-reference trigger raises 23503 with an `*_target_fk`
// constraint when target_id is missing/unknown or points at another workspace's
// connection. Surfacing it as a clean 4xx (instead of a generic 500) avoids both a
// confusing contract and an enumeration oracle on valid-format-but-foreign ids.
const isTargetReferenceViolation = (error: unknown): boolean => {
  const { code, constraint } = pgErrorMeta(error);
  return code === "23503" && typeof constraint === "string" && constraint.endsWith("_target_fk");
};

export class AgentSkillsService {
  constructor(private readonly options: AgentSkillsServiceOptions) {}

  async list(workspaceId: string, agentId: string): Promise<AgentSkillView[]> {
    const records = await this.options.repository.listByAgent(workspaceId, agentId);
    return records.map((record) => this.toView(record));
  }

  async create(workspaceId: string, agentId: string, rawInput: AgentSkillCreateInput): Promise<AgentSkillView> {
    const input = this.parseCreate(rawInput);
    const descriptor = this.requireCapability(input.capability);
    await this.validateCreateOrUpdate(workspaceId, agentId, descriptor, input);

    if (await this.options.repository.findByName(workspaceId, agentId, input.name)) {
      throw conflict(`A skill named "${input.name}" already exists for this agent`);
    }

    try {
      const record = await this.options.repository.create({
        workspaceId,
        agentId,
        skillName: input.name,
        kind: descriptor.storedKind,
        targetType: input.target.kind,
        targetId: input.target.id,
        config: input.config,
        invocationMode: input.invocationMode,
        enabled: input.enabled,
      });
      this.options.logger?.info({
        event: "agent_skill_created",
        workspaceId,
        agentId,
        skillId: record.id,
        capability: descriptor.id,
        invocationMode: input.invocationMode,
      });
      return this.toView(record);
    } catch (error) {
      throw this.translatePersistenceError(error, input.name, input.target);
    }
  }

  async update(
    workspaceId: string,
    agentId: string,
    id: string,
    rawInput: AgentSkillUpdateInput,
  ): Promise<AgentSkillView> {
    const input = this.parseUpdate(rawInput);
    const existing = await this.options.repository.findById(workspaceId, agentId, id);
    if (!existing) {
      throw notFound("Skill not found");
    }
    const descriptor = this.options.capabilities.getByStoredKind(existing.kind);
    if (!descriptor) {
      throw badRequest(`Unsupported skill kind "${existing.kind}"`);
    }
    const nextConfig = input.replaceConfig ?? { ...(existing.config ?? {}), ...(input.config ?? {}) };
    const invocationMode = input.invocationMode ?? existing.invocationMode;
    const target = input.target ?? { kind: existing.targetType ?? descriptor.targetKind, id: existing.targetId ?? null };
    await this.validateCreateOrUpdate(workspaceId, agentId, descriptor, {
      name: existing.skillName,
      capability: descriptor.id,
      target,
      config: nextConfig,
      invocationMode,
      enabled: input.enabled ?? existing.enabled,
    }, existing.id);

    try {
      const updated = await this.options.repository.update(workspaceId, agentId, id, {
        targetType: input.target?.kind,
        targetId: input.target?.id,
        config: input.config,
        replaceConfig: input.replaceConfig,
        invocationMode: input.invocationMode,
        enabled: input.enabled,
      });
      if (!updated) {
        throw notFound("Skill not found");
      }
      this.options.logger?.info({
        event: "agent_skill_updated",
        workspaceId,
        agentId,
        skillId: updated.id,
        capability: descriptor.id,
        invocationMode: updated.invocationMode,
      });
      return this.toView(updated);
    } catch (error) {
      throw this.translatePersistenceError(error, existing.skillName, target);
    }
  }

  /**
   * Maps a persistence-layer constraint violation to a precise client error.
   * Distinguishes a name collision from a default-answer collision (both 23505 but
   * different constraints) and turns an invalid/foreign target reference (23503)
   * into a 400 rather than letting it bubble up as a 500.
   */
  private translatePersistenceError(
    error: unknown,
    skillName: string,
    target: { kind: string; id: string | null },
  ): unknown {
    if (isUniqueViolation(error)) {
      const { constraint } = pgErrorMeta(error);
      if (constraint === "agent_skills_one_default_answer") {
        return conflict("A default-answer skill already exists for this agent");
      }
      return conflict(`A skill named "${skillName}" already exists for this agent`);
    }
    if (isTargetReferenceViolation(error)) {
      return badRequest(
        `Target ${target.id ?? "(none)"} is not a valid ${target.kind} for this agent`,
      );
    }
    return error;
  }

  async remove(workspaceId: string, agentId: string, id: string): Promise<void> {
    const removed = await this.options.repository.remove(workspaceId, agentId, id);
    if (!removed) {
      throw notFound("Skill not found");
    }
    this.options.logger?.info({
      event: "agent_skill_deleted",
      workspaceId,
      agentId,
      skillId: id,
    });
  }

  private requireCapability(capability: SkillCapabilityId): SkillCapabilityDescriptor {
    const descriptor = this.options.capabilities.get(capability);
    if (!descriptor) {
      throw badRequest(`Unsupported skill capability "${capability}"`);
    }
    return descriptor;
  }

  private parseCreate(rawInput: AgentSkillCreateInput): AgentSkillCreateInput {
    const parsed = agentSkillCreateSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw badRequest("Invalid skill definition", parsed.error.flatten());
    }
    return parsed.data;
  }

  private parseUpdate(rawInput: AgentSkillUpdateInput): AgentSkillUpdateInput {
    const parsed = agentSkillUpdateSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw badRequest("Invalid skill definition", parsed.error.flatten());
    }
    return parsed.data;
  }

  private async validateCreateOrUpdate(
    workspaceId: string,
    agentId: string,
    descriptor: SkillCapabilityDescriptor,
    input: AgentSkillCreateInput,
    existingId?: string,
  ): Promise<void> {
    if (input.target.kind !== descriptor.targetKind) {
      throw badRequest(`Capability ${descriptor.id} must target ${descriptor.targetKind}`);
    }
    if (!descriptor.supportedInvocationModes.includes(input.invocationMode)) {
      throw badRequest(`Capability ${descriptor.id} does not support ${input.invocationMode}`);
    }
    const config = descriptor.validateConfig(input.config);
    if (!config.success) {
      throw badRequest("Invalid skill config", config.error.flatten());
    }
    if (input.invocationMode === "default_answer") {
      const existingDefault = await this.options.repository.findDefaultAnswer(workspaceId, agentId);
      if (existingDefault && existingDefault.id !== existingId) {
        throw conflict("A default-answer skill already exists for this agent");
      }
    }
  }

  private toView(record: AgentSkillSpine): AgentSkillView {
    const descriptor = this.options.capabilities.getByStoredKind(record.kind);
    if (!descriptor) {
      throw badRequest(`Unsupported skill kind "${record.kind}"`);
    }
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      agentId: record.agentId,
      name: record.skillName,
      capability: descriptor.id,
      storedKind: record.kind,
      target: {
        kind: record.targetType ?? null,
        id: record.targetId ?? null,
      },
      config: record.config ?? {},
      invocationMode: record.invocationMode,
      enabled: record.enabled,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
}
