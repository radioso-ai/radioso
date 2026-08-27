import { z } from "zod";

import {
  AuthoredDirectiveService,
  DirectiveAuthorService,
  AgentService,
  mergeAgentSurfaceSettings,
  validateAgentInput,
  type AgentInput,
  type AuthoredDirectiveInput,
} from "../../modules/agents/public.js";
import {
  routineDefinitionDraftInputSchema,
  type RoutineDefinitionService,
  type RoutineDraftAssistService,
} from "../../modules/routines/public.js";
import { AgentSkillsService, type AgentSkillInvocationMode, type AgentSkillView } from "../../modules/agentSkills/public.js";
import { skillCapabilityIds, type SkillCapabilityDescriptor, type SkillCapabilityId, type SkillCapabilityRegistry } from "../../modules/skills/public.js";
import type {
  CopilotAgentSettingProposalAdapter,
  CopilotAgentSkillProposalAdapter,
  CopilotDirectiveProposalAdapter,
  CopilotRoutineProposalAdapter,
} from "../../modules/operatorCopilot/public.js";
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

/** Composition adapter: drafts through the existing coach and writes only through authored-directive management. */
export const createDirectiveCopilotProposalAdapter = (deps: {
  readonly authoredDirectiveService: Pick<AuthoredDirectiveService, "list" | "create" | "update">;
  readonly directiveAuthorService: Pick<DirectiveAuthorService, "draft">;
  readonly agentService: Pick<AgentService, "get">;
}): CopilotDirectiveProposalAdapter => ({
  targetType: "directive",
  async readVersionToken(workspaceId, rawTargetRef) {
    const targetRef = directiveTargetRefSchema.parse(rawTargetRef);
    if (!targetRef.directiveId) return versionToken((await deps.agentService.get(workspaceId, targetRef.agentId)).updatedAt);
    const directive = (await deps.authoredDirectiveService.list(workspaceId, targetRef.agentId)).find((item) => item.id === targetRef.directiveId);
    if (!directive) throw new Error("Directive no longer exists");
    return versionToken(directive.updatedAt);
  },
  async preview(workspaceId, rawTargetRef, payload) {
    const targetRef = directiveTargetRefSchema.parse(rawTargetRef);
    const proposed = directivePayload(payload);
    const current = targetRef.directiveId
      ? await deps.authoredDirectiveService.list(workspaceId, targetRef.agentId).then((directives) => directives.find((item) => item.id === targetRef.directiveId) ?? null).catch(() => null)
      : null;
    return { targetLabel: proposed.name, current, proposed };
  },
  async applyIfVersionMatches(workspaceId, rawTargetRef, payload, token) {
    const targetRef = directiveTargetRefSchema.parse(rawTargetRef);
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

    return {
      existing,
      normalized: {
        name,
        capability: descriptor.id,
        target,
        config: validatedConfig.data as Record<string, unknown>,
        invocationMode,
        enabled: payload.enabled ?? existing?.enabled ?? true,
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
