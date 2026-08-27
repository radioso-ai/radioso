import { z } from "zod";

import {
  AuthoredDirectiveService,
  DirectiveAuthorService,
  AgentService,
  mergeAgentSurfaceSettings,
  validateAgentInput,
  type AgentInput,
  type AuthoredDirective,
  type AuthoredDirectiveInput,
} from "../../modules/agents/public.js";
import {
  routineDefinitionDraftInputSchema,
  type RoutineDefinitionService,
  type RoutineDraftAssistService,
} from "../../modules/routines/public.js";
import {
  AgentSkillsService,
  agentSkillCreateSchema,
  agentSkillUpdateSchema,
  type AgentSkillInvocationMode,
  type AgentSkillView,
} from "../../modules/agentSkills/public.js";
import { skillCapabilityIds, type SkillCapabilityDescriptor, type SkillCapabilityId, type SkillCapabilityRegistry } from "../../modules/skills/public.js";
import type {
  CopilotAgentSettingProposalAdapter,
  CopilotAgentSkillProposalAdapter,
  CopilotContextVariableProposalAdapter,
  CopilotDirectiveProposalAdapter,
  CopilotRoutineProposalAdapter,
} from "../../modules/operatorCopilot/public.js";
import type { ContextVariable, AgentContextVariableEnablement } from "../../modules/context-variables/public.js";
import type { ContextVariableRepositoryPort } from "../../db/repositories/contextVariableRepository.js";
import { badRequest, notFound, AppError } from "../../shared/domain/errors.js";

const directiveTargetRefSchema = z.object({ agentId: z.string().uuid(), directiveId: z.string().uuid().nullable() }).strict();
const settingTargetRefSchema = z.object({ agentId: z.string().uuid(), settingKey: z.string().min(1).max(200) }).strict();
const routineTargetRefSchema = z.object({ agentId: z.string().uuid(), routineId: z.null() }).strict();
const settingPayloadSchema = z.object({ value: z.unknown(), rationale: z.string().min(1).max(1_000).optional() }).strict();
const skillTargetRefSchema = z.object({ agentId: z.string().uuid(), skillId: z.string().uuid().nullable() }).strict();
const skillTargetSchema = z.object({ kind: z.string().trim().min(1), id: z.string().uuid().nullable() }).strict();
const skillConfigPayloadSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  capability: z.string().trim().min(1).optional(),
  target: skillTargetSchema.optional(),
  config: z.record(z.unknown()).optional(),
  invocationMode: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict();
const skillConfigStoredPayloadSchema = z.object({
  name: z.string(),
  capability: z.string(),
  target: skillTargetSchema,
  config: z.record(z.unknown()),
  invocationMode: z.string(),
  enabled: z.boolean(),
  rationale: z.string().optional(),
}).strict();

// Mirrors contextVariableRoutes.ts's own literal arrays and superRefine business rules. The
// context-variables module has no service layer to validate against — the route is the only other
// place these rules are enforced, so this adapter re-states them the way skillConfigPayloadSchema
// re-states the capability registry's own shape rather than importing the route's zod schema.
const contextVariableValueTypes = ["string", "json"] as const;
const contextVariableTrustTiers = ["unverified", "signed"] as const;
const contextVariableSensitivities = ["normal", "sensitive"] as const;
const contextVariableSurfacings = ["always", "on_reference", "operator_only"] as const;
const contextVariableSources = ["pushed", "browser", "resolver"] as const;
const contextVariableTargetRefSchema = z.object({ agentId: z.string().uuid(), variableId: z.string().uuid().nullable() }).strict();
const contextVariableEnablementInputSchema = z.object({
  source: z.enum(contextVariableSources),
  resolverSkillId: z.string().uuid().nullable().optional(),
  maxAgeSeconds: z.number().int().nonnegative().nullable().optional(),
  resolverTimeoutMs: z.number().int().positive().nullable().optional(),
  surfacing: z.enum(contextVariableSurfacings),
  enabled: z.boolean().optional(),
}).strict();
const contextVariableProposalPayloadSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2_000).nullable().optional(),
  valueType: z.enum(contextVariableValueTypes).optional(),
  trustTier: z.enum(contextVariableTrustTiers).optional(),
  sensitivity: z.enum(contextVariableSensitivities).optional(),
  defaultSurfacing: z.enum(contextVariableSurfacings).optional(),
  enablement: contextVariableEnablementInputSchema.optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict();
const contextVariableDefinitionStoredSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  valueType: z.enum(contextVariableValueTypes),
  trustTier: z.enum(contextVariableTrustTiers),
  sensitivity: z.enum(contextVariableSensitivities),
  defaultSurfacing: z.enum(contextVariableSurfacings),
}).strict();
const contextVariableEnablementStoredSchema = z.object({
  source: z.enum(contextVariableSources),
  resolverSkillId: z.string().uuid().nullable(),
  maxAgeSeconds: z.number().int().nonnegative().nullable(),
  resolverTimeoutMs: z.number().int().positive().nullable(),
  surfacing: z.enum(contextVariableSurfacings),
  enabled: z.boolean(),
}).strict();
const contextVariableStoredPayloadSchema = z.object({
  name: z.string(),
  definition: contextVariableDefinitionStoredSchema.nullable(),
  enablement: contextVariableEnablementStoredSchema.nullable(),
  rationale: z.string().optional(),
}).strict();

/** Composition adapter: drafts through the existing coach and writes only through authored-directive management. */
export const createDirectiveCopilotProposalAdapter = (deps: {
  readonly authoredDirectiveService: Pick<AuthoredDirectiveService, "list" | "create" | "update" | "delete">;
  readonly directiveAuthorService: Pick<DirectiveAuthorService, "draft">;
  readonly agentService: Pick<AgentService, "get">;
}): CopilotDirectiveProposalAdapter => ({
  targetType: "directive",
  async readVersionToken(workspaceId, rawTargetRef) {
    const targetRef = directiveTargetRefSchema.parse(rawTargetRef);
    if (!targetRef.directiveId) return versionToken((await deps.agentService.get(workspaceId, targetRef.agentId)).updatedAt);
    const directive = await findDirectiveById(deps.authoredDirectiveService, workspaceId, targetRef.agentId, targetRef.directiveId);
    if (!directive) throw new Error("Directive no longer exists");
    return versionToken(directive.updatedAt);
  },
  async preview(workspaceId, rawTargetRef, payload) {
    const targetRef = directiveTargetRefSchema.parse(rawTargetRef);
    const current = await findDirectiveById(deps.authoredDirectiveService, workspaceId, targetRef.agentId, targetRef.directiveId).catch(() => null);
    if (isDirectiveRemoval(payload)) {
      return { targetLabel: payload.name ?? current?.name ?? "Directive", current, proposed: DIRECTIVE_REMOVAL_NOTICE };
    }
    const proposed = directivePayload(payload);
    return { targetLabel: proposed.name, current, proposed };
  },
  async applyIfVersionMatches(workspaceId, rawTargetRef, payload, token) {
    const targetRef = directiveTargetRefSchema.parse(rawTargetRef);
    if (isDirectiveRemoval(payload)) {
      if (!targetRef.directiveId) return { outcome: "failed" as const, reason: "Directive removal requires an existing directive" };
      try {
        const directive = await findDirectiveById(deps.authoredDirectiveService, workspaceId, targetRef.agentId, targetRef.directiveId);
        // Checked before the delete call rather than passed into it: AuthoredDirectiveService.delete
        // has no version-gated form, so a stale token must short-circuit here instead of letting a
        // delete run regardless of what changed underneath the proposal.
        if (!directive || versionToken(directive.updatedAt) !== token) return { outcome: "stale" as const };
        await deps.authoredDirectiveService.delete(workspaceId, targetRef.agentId, targetRef.directiveId);
        return { outcome: "applied" as const, appliedRef: { directiveId: targetRef.directiveId } };
      } catch (error) {
        if (isStale(error)) return { outcome: "stale" as const };
        return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Directive removal failed" };
      }
    }
    try {
      const directive = targetRef.directiveId
        ? (await deps.authoredDirectiveService.update(workspaceId, targetRef.agentId, targetRef.directiveId, directivePayload(payload), { expectedUpdatedAt: versionDate(token) })).directive
        : (await deps.authoredDirectiveService.create(workspaceId, targetRef.agentId, directivePayload(payload), { expectedAgentUpdatedAt: versionDate(token) })).directive;
      return { outcome: "applied" as const, appliedRef: { directiveId: directive.id } };
    } catch (error) {
      if (isStale(error)) return { outcome: "stale" as const };
      return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Directive apply failed" };
    }
  },
  async draft(workspaceId, rawTargetRef, intent) {
    const targetRef = directiveTargetRefSchema.parse(rawTargetRef);
    const draft = await deps.directiveAuthorService.draft(workspaceId, targetRef.agentId, {
      coachingText: intent,
      turn: { userMessage: intent, assistantAnswer: intent },
    });
    const directive = directivePayload(draft.directive);
    const summary = draft.rationale ?? directive.name;
    return { payload: { ...directive, rationale: summary }, targetLabel: directive.name, summary };
  },
});

/** Composition adapter: validates proposal values with the existing agent settings normalizer and applies through AgentService. */
export const createAgentSettingCopilotProposalAdapter = (deps: {
  readonly agentService: Pick<AgentService, "get" | "update">;
}): CopilotAgentSettingProposalAdapter => ({
  targetType: "agent_setting",
  async readVersionToken(workspaceId, rawTargetRef) {
    const targetRef = settingTargetRefSchema.parse(rawTargetRef);
    return versionToken((await deps.agentService.get(workspaceId, targetRef.agentId)).updatedAt);
  },
  async preview(workspaceId, rawTargetRef, rawPayload) {
    const targetRef = settingTargetRefSchema.parse(rawTargetRef);
    const payload = settingPayloadSchema.parse(rawPayload);
    const current = await deps.agentService.get(workspaceId, targetRef.agentId).catch(() => null);
    return { targetLabel: targetRef.settingKey, current: current ? settingValue(current, targetRef.settingKey) : null, proposed: payload.value };
  },
  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
    const targetRef = settingTargetRefSchema.parse(rawTargetRef);
    const payload = settingPayloadSchema.parse(rawPayload);
    try {
      await deps.agentService.update(workspaceId, targetRef.agentId, settingPatch(targetRef.settingKey, payload.value), { expectedUpdatedAt: versionDate(token) });
      return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId } };
    } catch (error) {
      if (isStale(error)) return { outcome: "stale" as const };
      return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Agent setting apply failed" };
    }
  },
  async validatePayload(workspaceId, rawTargetRef, rawPayload) {
    const targetRef = settingTargetRefSchema.parse(rawTargetRef);
    const payload = settingPayloadSchema.parse(rawPayload);
    const current = await deps.agentService.get(workspaceId, targetRef.agentId);
    const patch = settingPatch(targetRef.settingKey, payload.value);
    const merged = { ...current, ...patch, surfaceSettings: patch.surfaceSettings ? mergeAgentSurfaceSettings(current.surfaceSettings, patch.surfaceSettings) : current.surfaceSettings };
    const normalized = validateAgentInput(merged);
    if (!Object.hasOwn(normalized, targetRef.settingKey)) throw new Error("Unknown agent setting");
    return { targetRef, payload: { ...payload, value: settingValue(normalized, targetRef.settingKey) } };
  },
});

/**
 * Composition adapter: a skill config is supplied by Ray from settings it already read, not
 * drafted from prose, so validation happens entirely in `validatePayload` against the real
 * capability registry — the same registry the agent_skills reader lists settingsFields from.
 */
export const createAgentSkillCopilotProposalAdapter = (deps: {
  readonly agentService: Pick<AgentService, "get">;
  readonly agentSkillsService: Pick<AgentSkillsService, "list" | "create" | "update">;
  readonly skillCapabilityRegistry: SkillCapabilityRegistry;
}): CopilotAgentSkillProposalAdapter => {
  const findExisting = async (workspaceId: string, agentId: string, skillId: string | null): Promise<AgentSkillView | null> => {
    if (!skillId) return null;
    const skills = await deps.agentSkillsService.list(workspaceId, agentId);
    return skills.find((skill) => skill.id === skillId) ?? null;
  };

  /** Normalizes and fully validates a proposed skill against its resolved capability, without persisting. */
  const resolveProposal = async (workspaceId: string, targetRef: { agentId: string; skillId: string | null }, rawPayload: unknown) => {
    const payload = skillConfigPayloadSchema.parse(rawPayload);
    const existing = await findExisting(workspaceId, targetRef.agentId, targetRef.skillId);
    if (targetRef.skillId && !existing) throw notFound("Skill not found");

    // AgentSkillsService.update has no name or capability field at all (agentSkillUpdateSchema is
    // .strict() and omits both) - renaming or re-capabilitying an existing skill is not a supported
    // operation. A proposal that claimed one would preview cleanly and "apply successfully" while
    // persisting neither change, so it is refused here rather than reaching the operator.
    if (existing && payload.name !== undefined && payload.name !== existing.name) {
      throw badRequest(`Cannot rename the existing skill "${existing.name}" to "${payload.name}": the agent skills service has no rename path. Propose a new skill instead.`);
    }
    if (existing && payload.capability !== undefined && payload.capability !== existing.capability) {
      throw badRequest(`Cannot change the existing skill "${existing.name}"'s capability from "${existing.capability}" to "${payload.capability}": the agent skills service has no re-capability path. Propose a new skill instead.`);
    }

    const capabilityId = payload.capability ?? existing?.capability;
    if (!capabilityId) throw badRequest("A skill capability is required to propose a new skill");
    if (!isSkillCapabilityId(capabilityId)) throw badRequest(`Unsupported skill capability "${capabilityId}"`);
    const descriptor = deps.skillCapabilityRegistry.get(capabilityId);
    if (!descriptor) throw badRequest(`Unsupported skill capability "${capabilityId}"`);

    const name = payload.name ?? existing?.name;
    if (!name) throw badRequest("A skill name is required to propose a new skill");

    const config = mergeSkillConfig(existing?.config, payload.config);
    assertDependentSettingsAreGated(descriptor.settingsFields, payload.config ?? {}, config);
    assertNotifyDeliveryIsReachable(descriptor.id, config);
    const validatedConfig = descriptor.validateConfig(config);
    if (!validatedConfig.success) {
      throw badRequest(`Invalid configuration for the "${descriptor.id}" skill capability`, validatedConfig.error.flatten());
    }

    const invocationMode = payload.invocationMode ?? existing?.invocationMode ?? descriptor.defaultInvocationMode ?? descriptor.supportedInvocationModes[0];
    if (!invocationMode || !descriptor.supportedInvocationModes.includes(invocationMode as AgentSkillInvocationMode)) {
      throw badRequest(`The "${descriptor.id}" skill capability does not support invocation mode "${invocationMode}"`);
    }
    const target = payload.target ?? existing?.target ?? { kind: descriptor.targetKind, id: null };
    const normalized = {
      name,
      capability: descriptor.id,
      target,
      config: validatedConfig.data as Record<string, unknown>,
      invocationMode,
      enabled: payload.enabled ?? existing?.enabled ?? true,
    };

    // Validated here against the same exported schemas AgentSkillsService.create/update parse
    // internally, so a name or shape the service would reject on Apply (e.g. "FAQ Search" failing
    // the create schema's lowercase-snake-case rule) is caught before the proposal is ever
    // persisted, not only after the operator clicks Apply.
    const schemaResult = existing
      ? agentSkillUpdateSchema.safeParse({ target: normalized.target, replaceConfig: normalized.config, invocationMode: normalized.invocationMode, enabled: normalized.enabled })
      : agentSkillCreateSchema.safeParse(normalized);
    if (!schemaResult.success) {
      throw badRequest(`This skill configuration would be rejected by the agent skills service: ${describeSchemaIssues(normalized, schemaResult.error)}`);
    }

    return {
      existing,
      normalized: {
        ...normalized,
        ...(payload.rationale ? { rationale: payload.rationale } : {}),
      },
    };
  };

  return {
    targetType: "agent_skill",
    async readVersionToken(workspaceId, rawTargetRef) {
      const targetRef = skillTargetRefSchema.parse(rawTargetRef);
      if (targetRef.skillId) {
        const existing = await findExisting(workspaceId, targetRef.agentId, targetRef.skillId);
        if (!existing) throw notFound("Skill no longer exists");
        return versionToken(new Date(existing.updatedAt));
      }
      return versionToken((await deps.agentService.get(workspaceId, targetRef.agentId)).updatedAt);
    },
    async preview(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = skillTargetRefSchema.parse(rawTargetRef);
      const payload = skillConfigStoredPayloadSchema.parse(rawPayload);
      const existing = await findExisting(workspaceId, targetRef.agentId, targetRef.skillId);
      return { targetLabel: payload.name, current: existing, proposed: payload };
    },
    async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
      const targetRef = skillTargetRefSchema.parse(rawTargetRef);
      const payload = skillConfigStoredPayloadSchema.parse(rawPayload);
      try {
        if (targetRef.skillId) {
          const currentToken = versionToken(new Date((await findExisting(workspaceId, targetRef.agentId, targetRef.skillId))?.updatedAt ?? 0));
          if (currentToken !== token) return { outcome: "stale" as const };
          const updated = await deps.agentSkillsService.update(workspaceId, targetRef.agentId, targetRef.skillId, {
            target: payload.target,
            replaceConfig: payload.config,
            invocationMode: payload.invocationMode as AgentSkillInvocationMode,
            enabled: payload.enabled,
          });
          return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, skillId: updated.id } };
        }
        const agent = await deps.agentService.get(workspaceId, targetRef.agentId);
        if (versionToken(agent.updatedAt) !== token) return { outcome: "stale" as const };
        const created = await deps.agentSkillsService.create(workspaceId, targetRef.agentId, {
          name: payload.name,
          capability: payload.capability as SkillCapabilityId,
          target: payload.target,
          config: payload.config,
          invocationMode: payload.invocationMode as AgentSkillInvocationMode,
          enabled: payload.enabled,
        });
        return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, skillId: created.id } };
      } catch (error) {
        if (isStale(error)) return { outcome: "stale" as const };
        return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Skill apply failed" };
      }
    },
    async validatePayload(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = skillTargetRefSchema.parse(rawTargetRef);
      const { normalized } = await resolveProposal(workspaceId, targetRef, rawPayload);
      return { targetRef, payload: normalized };
    },
  };
};

/** Composition adapter: turns a coached authored routine into a draft-only proposal. */
export const createRoutineCopilotProposalAdapter = (deps: {
  readonly agentService: Pick<AgentService, "get">;
  readonly routineDraftAssistService: Pick<RoutineDraftAssistService, "draft">;
  readonly routineDefinitionService: Pick<RoutineDefinitionService, "createDraft">;
}): CopilotRoutineProposalAdapter => ({
  targetType: "routine",
  async readVersionToken(workspaceId, rawTargetRef) {
    const targetRef = routineTargetRefSchema.parse(rawTargetRef);
    return versionToken((await deps.agentService.get(workspaceId, targetRef.agentId)).updatedAt);
  },
  async preview(_workspaceId, _rawTargetRef, payload) {
    const proposed = routinePayload(payload);
    return { targetLabel: proposed.name, current: null, proposed };
  },
  async applyIfVersionMatches(workspaceId, rawTargetRef, payload, token) {
    const targetRef = routineTargetRefSchema.parse(rawTargetRef);
    try {
      const agent = await deps.agentService.get(workspaceId, targetRef.agentId);
      if (versionToken(agent.updatedAt) !== token) return { outcome: "stale" as const };
      const result = await deps.routineDefinitionService.createDraft(workspaceId, targetRef.agentId, routinePayload(payload));
      // The card deep-links from appliedRef alone when the proposal detail was
      // never loaded, so the agent id must travel with the routine id.
      return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, routineId: result.routine.id } };
    } catch (error) {
      if (isStale(error)) return { outcome: "stale" as const };
      return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Routine draft creation failed" };
    }
  },
  async draft(workspaceId, rawTargetRef, intent) {
    const targetRef = routineTargetRefSchema.parse(rawTargetRef);
    const result = await deps.routineDraftAssistService.draft(workspaceId, targetRef.agentId, { prose: intent });
    const diagnostics = result.validation.diagnostics.length;
    const summary = diagnostics === 0
      ? `Draft routine ${result.draft.name}.`
      : `Draft routine ${result.draft.name} has ${diagnostics} open validation diagnostic${diagnostics === 1 ? "" : "s"}.`;
    // The card summary is rebuilt from payload.rationale after a reload, so
    // the summary rides the stored payload the same way directive drafts do.
    return { payload: { ...result.draft, rationale: summary }, targetLabel: result.draft.name, summary };
  },
});

const findDirectiveById = async (
  service: Pick<AuthoredDirectiveService, "list">,
  workspaceId: string,
  agentId: string,
  directiveId: string | null,
): Promise<AuthoredDirective | null> => {
  if (!directiveId) return null;
  const directives = await service.list(workspaceId, agentId);
  return directives.find((item) => item.id === directiveId) ?? null;
};

interface DirectiveRemovalPayload {
  readonly op: "remove";
  /** Presentation-only, mirrors how a save payload's own `name`/`rationale` re-derive the card on reload. */
  readonly name?: string;
  readonly rationale?: string;
}

// A payload missing `op` is the save shape every proposal used before removal existed, so it must
// keep reading as a save. Only an explicit `op: "remove"` selects the removal branch.
const isDirectiveRemoval = (payload: unknown): payload is DirectiveRemovalPayload =>
  typeof payload === "object" && payload !== null && (payload as { op?: unknown }).op === "remove";

/**
 * Shown as the "proposed" side of a removal's preview. A plain notice reads far more clearly than
 * the generic diff algorithm's default for a record `current` next to a null/undefined `proposed`:
 * recursing into every field of the directive and marking each one individually removed.
 */
const DIRECTIVE_REMOVAL_NOTICE = "This directive will be permanently removed.";

// Maps a stored proposal payload onto the management input. The draft keeps
// presentation extras (e.g. the coach's rationale) that the .strict()
// directive input schema rejects, so unknown keys are stripped here.
const directivePayload = (value: unknown): AuthoredDirectiveInput => {
  const draft = z.object({
    name: z.string(),
    condition: z.unknown(),
    action: z.string(),
    tags: z.array(z.string()).optional(),
    priority: z.number().nullable().optional(),
    criticality: z.unknown().optional(),
    requiredCapabilities: z.array(z.string()).optional(),
    dependsOn: z.array(z.string()).optional(),
    excludes: z.array(z.string()).optional(),
    description: z.string().optional(),
    binding: z.unknown().optional(),
    lifecycle: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional(),
  }).parse(value);
  return draft as AuthoredDirectiveInput;
};

// Strips the draft-only rationale before the .strict() authoring schema, the
// same way directivePayload drops the coach's presentation extras.
const routinePayload = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { rationale: _rationale, ...rest } = value as Record<string, unknown>;
    return routineDefinitionDraftInputSchema.parse(rest);
  }
  return routineDefinitionDraftInputSchema.parse(value);
};

const settingPatch = (settingKey: string, value: unknown): AgentInput => ({ [settingKey]: value }) as AgentInput;
const settingValue = (settings: object, settingKey: string): unknown => Object.hasOwn(settings, settingKey) ? (settings as Record<string, unknown>)[settingKey] : undefined;
const versionToken = (updatedAt: Date): string => updatedAt.toISOString();
const versionDate = (token: string): Date => new Date(token);
const isStale = (error: unknown): boolean => error instanceof AppError && (error.code === "conflict" || error.code === "not_found");

const isSkillCapabilityId = (value: string): value is SkillCapabilityId => (skillCapabilityIds as readonly string[]).includes(value);

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Mirrors AgentSkillsService.update's own shallow, top-level merge, so the config validated here
// is the config that will actually be persisted.
const mergeSkillConfig = (existing: Record<string, unknown> | undefined, proposed: Record<string, unknown> | undefined): Record<string, unknown> => ({
  ...(existing ?? {}),
  ...(proposed ?? {}),
});

const readByPath = (source: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>(
    (value, segment) => value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[segment] : undefined,
    source,
  );

/**
 * Turns a rejection from the service's own schema into a message Ray can act on: which field,
 * what it was, and why it failed - without restating the rule the schema already enforces.
 */
const describeSchemaIssues = (input: Record<string, unknown>, error: z.ZodError): string =>
  error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.map(String).join(".") : "value";
    const received = issue.path.length ? readByPath(input, path) : input;
    return `${path} (received ${JSON.stringify(received)}): ${issue.message}`;
  }).join("; ");

/**
 * A settings field with `dependsOnKey` only takes effect while its parent is on. Ray proposing a
 * value for the dependent field while the parent is off (or left off by this same proposal) would
 * silently no-op once applied, so that combination is refused rather than accepted.
 */
const assertDependentSettingsAreGated = (
  settingsFields: SkillCapabilityDescriptor["settingsFields"],
  proposedPatch: Record<string, unknown>,
  effectiveConfig: Record<string, unknown>,
): void => {
  for (const field of settingsFields) {
    if (!field.dependsOnKey) continue;
    if (readByPath(proposedPatch, field.key) === undefined) continue;
    if (!readByPath(effectiveConfig, field.dependsOnKey)) {
      throw badRequest(`"${field.key}" depends on "${field.dependsOnKey}", which is off. Turn "${field.dependsOnKey}" on first, or remove "${field.key}" from this proposal.`);
    }
  }
};

/**
 * notify's delivery.recipientEmails and delivery.webhook.url have no safe default: an empty
 * delivery config passes the capability's own schema (both fields default to empty/null) but
 * fires without effect. Ray cannot invent a recipient address or a webhook URL, so a proposal that
 * leaves both unset is refused rather than silently creating a no-op notification.
 */
const assertNotifyDeliveryIsReachable = (capabilityId: string, config: Record<string, unknown>): void => {
  if (capabilityId !== "notify") return;
  const delivery = asRecord(config.delivery);
  const recipients = Array.isArray(delivery.recipientEmails) ? delivery.recipientEmails : [];
  const webhookUrl = asRecord(delivery.webhook).url;
  if (recipients.length === 0 && typeof webhookUrl !== "string") {
    throw badRequest("This notify skill has no recipient email and no webhook URL. Ask the operator which to use before proposing this change.");
  }
};

interface NormalizedContextVariableDefinition {
  readonly name: string;
  readonly description: string | null;
  readonly valueType: ContextVariable["valueType"];
  readonly trustTier: ContextVariable["trustTier"];
  readonly sensitivity: ContextVariable["sensitivity"];
  readonly defaultSurfacing: ContextVariable["defaultSurfacing"];
}

interface NormalizedContextVariableEnablement {
  readonly source: AgentContextVariableEnablement["source"];
  readonly resolverSkillId: string | null;
  readonly maxAgeSeconds: number | null;
  readonly resolverTimeoutMs: number | null;
  readonly surfacing: AgentContextVariableEnablement["surfacing"];
  readonly enabled: boolean;
}

const findAgentContextVariableEnablement = async (
  contextVariableRepository: Pick<ContextVariableRepositoryPort, "listByAgent">,
  workspaceId: string,
  agentId: string,
  variableId: string | null,
): Promise<AgentContextVariableEnablement | null> => {
  if (!variableId) return null;
  const enablements = await contextVariableRepository.listByAgent(workspaceId, agentId);
  return enablements.find((enablement) => enablement.variableId === variableId) ?? null;
};

/**
 * Mirrors contextVariableRoutes.ts's own superRefine: browser-sourced variables have no resolver
 * pipeline yet, a resolver source must name the skill that supplies the value, and every other
 * source must not carry resolver-only fields — an enablement combining those would be inert or
 * contradictory once persisted.
 */
const assertEnablementIsWellFormed = (enablement: z.infer<typeof contextVariableEnablementInputSchema>): void => {
  if (enablement.source === "browser") {
    throw badRequest("browser-sourced context variables are not yet supported");
  }
  if (enablement.source === "resolver") {
    if (!enablement.resolverSkillId) {
      throw badRequest("resolverSkillId is required when source is resolver");
    }
    return;
  }
  if (enablement.resolverSkillId !== undefined && enablement.resolverSkillId !== null) {
    throw badRequest("resolverSkillId is only allowed when source is resolver");
  }
  if (enablement.maxAgeSeconds !== undefined && enablement.maxAgeSeconds !== null) {
    throw badRequest("maxAgeSeconds is only allowed when source is resolver");
  }
  if (enablement.resolverTimeoutMs !== undefined && enablement.resolverTimeoutMs !== null) {
    throw badRequest("resolverTimeoutMs is only allowed when source is resolver");
  }
};

/**
 * Composition adapter: a context variable's workspace-scoped definition and one agent's
 * enablement of it are two separate resources this adapter can create or update from a single
 * proposal. Ray supplies concrete field values it already read (from the context_variables
 * reader), never a draft from prose, so validation happens entirely in `validatePayload` — the
 * same shape as propose_skill_config.
 */
export const createContextVariableCopilotProposalAdapter = (deps: {
  readonly agentService: Pick<AgentService, "get">;
  readonly contextVariableRepository: Pick<ContextVariableRepositoryPort, "get" | "create" | "update" | "listByAgent" | "upsertEnablement">;
}): CopilotContextVariableProposalAdapter => {
  const findEnablement = (workspaceId: string, agentId: string, variableId: string | null) =>
    findAgentContextVariableEnablement(deps.contextVariableRepository, workspaceId, agentId, variableId);

  // A proposal can touch the definition, the enablement, or both, so the version token guards
  // whichever of the two was most recently changed — the one a stale apply would otherwise clobber.
  const readCurrentToken = async (workspaceId: string, targetRef: { agentId: string; variableId: string | null }): Promise<string> => {
    if (!targetRef.variableId) {
      return versionToken((await deps.agentService.get(workspaceId, targetRef.agentId)).updatedAt);
    }
    const variable = await deps.contextVariableRepository.get(workspaceId, targetRef.variableId);
    if (!variable) throw notFound("Context variable no longer exists");
    const enablement = await findEnablement(workspaceId, targetRef.agentId, targetRef.variableId);
    const latest = enablement && enablement.updatedAt.getTime() > variable.updatedAt.getTime() ? enablement.updatedAt : variable.updatedAt;
    return versionToken(latest);
  };

  const resolveProposal = async (workspaceId: string, targetRef: { agentId: string; variableId: string | null }, rawPayload: unknown) => {
    const payload = contextVariableProposalPayloadSchema.parse(rawPayload);
    const existing = targetRef.variableId ? await deps.contextVariableRepository.get(workspaceId, targetRef.variableId) : null;
    if (targetRef.variableId && !existing) throw notFound("Context variable not found");

    const hasDefinitionFields = payload.name !== undefined || payload.description !== undefined
      || payload.valueType !== undefined || payload.trustTier !== undefined
      || payload.sensitivity !== undefined || payload.defaultSurfacing !== undefined;
    if (!existing && !hasDefinitionFields) {
      throw badRequest("A new context variable needs a name, value type, trust tier, sensitivity, and default surfacing");
    }
    if (!hasDefinitionFields && !payload.enablement) {
      throw badRequest("Propose a variable definition change, an agent enablement change, or both");
    }

    let definition: NormalizedContextVariableDefinition | null = null;
    if (hasDefinitionFields || !existing) {
      const name = payload.name ?? existing?.name;
      const valueType = payload.valueType ?? existing?.valueType;
      const trustTier = payload.trustTier ?? existing?.trustTier;
      const sensitivity = payload.sensitivity ?? existing?.sensitivity;
      const defaultSurfacing = payload.defaultSurfacing ?? existing?.defaultSurfacing;
      if (!name) throw badRequest("A context variable name is required to propose a new variable");
      if (!valueType) throw badRequest("A value type is required to propose a new variable");
      if (!trustTier) throw badRequest("A trust tier is required to propose a new variable");
      if (!sensitivity) throw badRequest("A sensitivity is required to propose a new variable");
      if (!defaultSurfacing) throw badRequest("A default surfacing is required to propose a new variable");
      definition = {
        name,
        description: "description" in payload ? payload.description ?? null : existing?.description ?? null,
        valueType,
        trustTier,
        sensitivity,
        defaultSurfacing,
      };
    }

    let enablement: NormalizedContextVariableEnablement | null = null;
    if (payload.enablement) {
      assertEnablementIsWellFormed(payload.enablement);
      enablement = {
        source: payload.enablement.source,
        resolverSkillId: payload.enablement.resolverSkillId ?? null,
        maxAgeSeconds: payload.enablement.maxAgeSeconds ?? null,
        resolverTimeoutMs: payload.enablement.resolverTimeoutMs ?? null,
        surfacing: payload.enablement.surfacing,
        enabled: payload.enablement.enabled ?? true,
      };
    }

    return {
      existing,
      normalized: {
        name: definition?.name ?? existing!.name,
        definition,
        enablement,
        ...(payload.rationale ? { rationale: payload.rationale } : {}),
      },
    };
  };

  return {
    targetType: "context_variable",
    async readVersionToken(workspaceId, rawTargetRef) {
      const targetRef = contextVariableTargetRefSchema.parse(rawTargetRef);
      return readCurrentToken(workspaceId, targetRef);
    },
    async preview(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = contextVariableTargetRefSchema.parse(rawTargetRef);
      const payload = contextVariableStoredPayloadSchema.parse(rawPayload);
      const existing = targetRef.variableId ? await deps.contextVariableRepository.get(workspaceId, targetRef.variableId) : null;
      const existingEnablement = await findEnablement(workspaceId, targetRef.agentId, targetRef.variableId);
      return { targetLabel: payload.name, current: { definition: existing, enablement: existingEnablement }, proposed: payload };
    },
    async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
      const targetRef = contextVariableTargetRefSchema.parse(rawTargetRef);
      const payload = contextVariableStoredPayloadSchema.parse(rawPayload);
      try {
        const currentToken = await readCurrentToken(workspaceId, targetRef);
        if (currentToken !== token) return { outcome: "stale" as const };

        let variableId = targetRef.variableId;
        if (payload.definition) {
          if (variableId) {
            await deps.contextVariableRepository.update(workspaceId, variableId, payload.definition);
          } else {
            const created = await deps.contextVariableRepository.create({ workspaceId, ...payload.definition });
            variableId = created.id;
          }
        }
        if (payload.enablement) {
          if (!variableId) throw badRequest("Cannot enable a context variable with no resolved id");
          await deps.contextVariableRepository.upsertEnablement({ agentId: targetRef.agentId, variableId, ...payload.enablement });
        }
        return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, variableId } };
      } catch (error) {
        if (isStale(error)) return { outcome: "stale" as const };
        return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Context variable apply failed" };
      }
    },
    async validatePayload(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = contextVariableTargetRefSchema.parse(rawTargetRef);
      const { normalized } = await resolveProposal(workspaceId, targetRef, rawPayload);
      return { targetRef, payload: normalized };
    },
  };
};
