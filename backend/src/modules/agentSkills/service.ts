import { z } from "zod";

import { badRequest, conflict, notFound } from "../../shared/domain/errors.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import {
  skillCapabilityIdSchema,
  type SkillCapabilityDescriptor,
  type SkillCapabilityId,
  type SkillCapabilityRegistry,
} from "../skills/public.js";
import { mergeSkillConfig } from "./configMerge.js";
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

export interface AgentSkillUpdateOptions {
  expectedUpdatedAt?: Date;
}

/**
 * A caller-assembled candidate for validation-without-persisting via `dryRunValidate`. Looser than
 * `AgentSkillCreateInput` on purpose: a caller that already merged an existing skill's target/config
 * with a proposed patch (the operator-copilot proposal adapter) may be holding a `target.kind` of
 * `null` (a stored no-target skill's view) or an unvalidated `config`/`invocationMode`, and
 * `dryRunValidate` re-validates all of it through the same schema `create`/`update` do.
 */
export interface AgentSkillConfigurationCandidate {
  readonly name: string;
  readonly capability: SkillCapabilityId;
  readonly target: { readonly kind: string | null; readonly id: string | null };
  readonly config: unknown;
  readonly invocationMode: string;
  readonly enabled: boolean;
}

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
    // Name uniqueness is checked inside validateCreateOrUpdate (the same path dryRunValidate
    // runs), not here: a copilot proposal validates through dryRunValidate before this method
    // ever runs, and a name collision it can't see would draft a proposal Apply can only reject.
    // The DB's own unique constraint (agent_skills_agent_id_skill_name_key), caught below by
    // translatePersistenceError, remains the backstop for a genuine race against this check.
    await this.validateCreateOrUpdate(workspaceId, agentId, descriptor, input);

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
    options: AgentSkillUpdateOptions = {},
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
    // Validate against the same deep merge AgentSkillRepository.update actually persists
    // (mergeSkillConfig), not a shallow top-level spread: a shallow candidate replaces a whole
    // nested key (e.g. email's boundInputs) wholesale when the patch only touches one of its
    // siblings, so it can fail a capability's required-field check the repository's real,
    // sibling-preserving merge would have satisfied.
    const nextConfig = input.replaceConfig ?? mergeSkillConfig(existing.config, input.config);
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
        // Only forwarded when the caller's patch actually named a `target` (agentSkillUpdateSchema
        // requires both `kind` and `id` together, never one alone): the repository treats *key
        // presence* as "explicitly change target_id, including to null" (see its own doc comment),
        // so unconditionally forwarding these two keys - even as `undefined` - would tell it every
        // config-only or enabled-only patch means "clear the target," which the target-reference
        // trigger then rejects outright for any capability that requires one.
        ...(input.target ? { targetType: input.target.kind, targetId: input.target.id } : {}),
        config: input.config,
        replaceConfig: input.replaceConfig,
        invocationMode: input.invocationMode,
        enabled: input.enabled,
        expectedUpdatedAt: options.expectedUpdatedAt,
        // The candidate validated above is built from *this* read of `existing`; a concurrent
        // writer can commit between that read and the repository actually taking its lock. The
        // repository recomputes the real merge once it holds the lock and calls this back with
        // it, so the config that gets persisted is the config that gets validated, not the one
        // validated here against a base that may already be stale.
        validateMergedConfig: (mergedConfig) => this.assertValidMergedConfig(descriptor, mergedConfig),
      });
      if (!updated) {
        // The repository's own WHERE predicate is what enforces expectedUpdatedAt (not a
        // read-then-compare here), so zero rows with a version supplied means a concurrent edit
        // raced this update - report it as a conflict, matching AuthoredDirectiveService's
        // equivalent distinction.
        throw options.expectedUpdatedAt ? conflict("Skill was updated by another writer; reload before saving again") : notFound("Skill not found");
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

  // Accepts unknown rather than AgentSkillCreateInput: it is the runtime gate that produces that
  // type, so a caller (dryRunValidate included) must be able to hand it an unvalidated candidate.
  private parseCreate(rawInput: unknown): AgentSkillCreateInput {
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

  /**
   * Runs exactly the validation `create`/`update` perform - capability resolution, target-kind
   * match, invocation-mode support, capability config schema, and the async default-answer
   * uniqueness check - without persisting anything, and returns the config coerced by the
   * capability's own schema (nested defaults filled in). `existingId` marks the candidate as a
   * full replacement for that skill, matching `update`'s own exclusion of itself from the
   * default-answer conflict check.
   *
   * This is the single validation path `create`/`update` and the operator-copilot proposal
   * adapter now share: a caller that assembles its own full candidate (the adapter always applies
   * through a full `replaceConfig`, since it can't express `AgentSkillsService.update`'s partial
   * merge without re-losing the sibling-field guarantee `dryRunValidate`'s caller already
   * enforced) can validate it the same way `create`/`update` would, instead of finding out only
   * when an operator clicks Apply.
   */
  async dryRunValidate(
    workspaceId: string,
    agentId: string,
    candidate: AgentSkillConfigurationCandidate,
    existingId?: string,
  ): Promise<Record<string, unknown>> {
    const input = this.parseCreate(candidate);
    const descriptor = this.requireCapability(input.capability);
    return this.validateCreateOrUpdate(workspaceId, agentId, descriptor, input, existingId);
  }

  private async validateCreateOrUpdate(
    workspaceId: string,
    agentId: string,
    descriptor: SkillCapabilityDescriptor,
    input: AgentSkillCreateInput,
    existingId?: string,
  ): Promise<Record<string, unknown>> {
    if (input.target.kind !== descriptor.targetKind) {
      throw badRequest(`Capability ${descriptor.id} must target ${descriptor.targetKind}`);
    }
    // A proposal that can never apply must not be created (the same rule already applied to a
    // colliding skill name and a colliding context-variable name below/elsewhere): a capability
    // that requires a target must be given one, and a supplied id must actually be one of this
    // workspace/agent's targets - not merely well-formed. Checked here, shared by create/update
    // and dryRunValidate, so a copilot proposal with a missing or foreign target id is refused
    // when it is drafted instead of becoming a pending card that only fails once Apply is clicked.
    const requiresTarget = descriptor.requiresTarget ?? true;
    if (requiresTarget && !input.target.id) {
      throw badRequest(`Capability ${descriptor.id} requires a ${descriptor.targetKind} target`);
    }
    if (input.target.id) {
      const targets = await descriptor.enumerateTargets({ workspaceId, agentId });
      if (!targets.some((target) => target.id === input.target.id)) {
        throw badRequest(`Target ${input.target.id} is not a valid ${descriptor.targetKind} for this agent`);
      }
    }
    if (!descriptor.supportedInvocationModes.includes(input.invocationMode)) {
      throw badRequest(`Capability ${descriptor.id} does not support ${input.invocationMode}`);
    }
    const config = descriptor.validateConfig(input.config);
    if (!config.success) {
      throw badRequest("Invalid skill config", config.error.flatten());
    }
    // Shared by create() and dryRunValidate() so a copilot proposal that would collide on name is
    // refused when it is drafted, not only once Apply's own insert hits the same unique constraint
    // (agent_skills_agent_id_skill_name_key). existingId excludes a skill validating against
    // itself, matching the default-answer check below - update() never changes name (see
    // resolveProposal's rename guard in copilotProposalAdapters.ts), so this is always a no-op there.
    const sameName = await this.options.repository.findByName(workspaceId, agentId, input.name);
    if (sameName && sameName.id !== existingId) {
      throw conflict(`A skill named "${input.name}" already exists for this agent`);
    }
    if (input.invocationMode === "default_answer") {
      const existingDefault = await this.options.repository.findDefaultAnswer(workspaceId, agentId);
      if (existingDefault && existingDefault.id !== existingId) {
        throw conflict("A default-answer skill already exists for this agent");
      }
    }
    return config.data as Record<string, unknown>;
  }

  /**
   * Callback the repository invokes, inside its own locked transaction, with the config it
   * actually computed by merging a patch into the row's *current* stored config - not the
   * candidate `update()` validated a moment earlier against its own pre-lock read of that row.
   * Throwing here (instead of returning a boolean) lets the repository simply propagate the
   * failure out of its transaction, aborting the write without persisting anything.
   */
  private assertValidMergedConfig(descriptor: SkillCapabilityDescriptor, mergedConfig: Record<string, unknown>): void {
    if (!descriptor.validateConfig(mergedConfig).success) {
      throw conflict("Concurrent edits produced an invalid configuration; reload and try again");
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
