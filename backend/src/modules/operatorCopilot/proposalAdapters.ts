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
} from "../agents/public.js";
import {
  applyRoutineFieldPatch,
  describeRoutineFieldPatch,
  projectRoutineForReview,
  RoutineDefinitionLifecycleCommittedError,
  routineDefinitionDraftInputSchema,
  routineFieldPatchSchema,
  type RoutineDefinition,
  type RoutineDefinitionService,
  type RoutineDraftAssistService,
  type RoutineValidationDiagnostic,
} from "../routines/public.js";
import {
  AgentSkillsService,
  mergeSkillConfig,
  type AgentSkillInvocationMode,
  type AgentSkillView,
} from "../agentSkills/public.js";
import { skillCapabilityIds, type SkillCapabilityDescriptor, type SkillCapabilityId, type SkillCapabilityRegistry } from "../skills/public.js";
import type {
  CopilotAgentSettingProposalAdapter,
  CopilotAgentSkillProposalAdapter,
  CopilotContextVariableProposalAdapter,
  CopilotDirectiveProposalAdapter,
  CopilotRoutineLifecycleAction,
  CopilotRoutineProposalAdapter,
} from "./contracts.js";
import type { ContextVariable, AgentContextVariableEnablement } from "../context-variables/public.js";
import type { ContextVariableRepositoryPort } from "../../db/repositories/contextVariableRepository.js";
import { badRequest, conflict, notFound, AppError } from "../../shared/domain/errors.js";

const directiveTargetRefSchema = z.object({ agentId: z.string().uuid(), directiveId: z.string().uuid().nullable() }).strict();
const settingTargetRefSchema = z.object({ agentId: z.string().uuid(), settingKey: z.string().min(1).max(200) }).strict();
const routineTargetRefSchema = z.object({ agentId: z.string().uuid(), routineId: z.string().uuid().nullable() }).strict();
const routineLifecycleActions = ["publish", "archive", "restore"] as const;
// The card summary is rebuilt from `payload.rationale` after a reload, which is why every routine
// payload carries the drafted summary under that name rather than only Ray's own words.
const routineEditPayloadSchema = z.object({
  kind: z.literal("edit"),
  name: z.string(),
  changes: routineFieldPatchSchema,
  rationale: z.string().optional(),
}).strict();
const routineLifecyclePayloadSchema = z.object({
  kind: z.literal("lifecycle"),
  action: z.enum(routineLifecycleActions),
  name: z.string(),
  rationale: z.string().optional(),
  /** The draft revision archiving deletes, as disclosed when the proposal was drafted. */
  discardsDraftRevisionId: z.string().uuid().optional(),
  /** Its version at that moment, so an edit made to it since is not thrown away unannounced. */
  discardsDraftRevisionUpdatedAt: z.string().optional(),
}).strict();
// Payloads written before routine edits existed carry no `kind`; an absent one is a new-routine draft.
const routinePayloadKind = (payload: unknown): "edit" | "lifecycle" | "create" => {
  const kind = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>).kind : undefined;
  return kind === "edit" || kind === "lifecycle" ? kind : "create";
};
// A draft is edited in place and a published routine is revised into one first. Anything else —
// archived, or a version something newer superseded — has no draft to edit.
const editableRoutineStatus = (routine: Pick<RoutineDefinition, "status">): boolean =>
  routine.status === "draft" || routine.status === "published";
const uneditableRoutineReason = (routine: Pick<RoutineDefinition, "name" | "status">): string =>
  `Routine ${routine.name} is ${routine.status}. Restore an archived routine, or edit the current version, before proposing changes.`;
const requiredRoutineId = (targetRef: { routineId: string | null }): string => {
  if (!targetRef.routineId) throw new Error("This routine proposal names no routine");
  return targetRef.routineId;
};
const routineStatusForAction: Record<CopilotRoutineLifecycleAction, RoutineDefinition["status"]> = {
  publish: "draft",
  archive: "published",
  restore: "archived",
};
const routineStatusAfterAction: Record<CopilotRoutineLifecycleAction, RoutineDefinition["status"]> = {
  publish: "published",
  archive: "archived",
  restore: "published",
};
/** Publish and restore both end with the routine serving customers; archive takes it out of play. */
const goesLive = (action: CopilotRoutineLifecycleAction): boolean => action !== "archive";
const routineActionVerb: Record<CopilotRoutineLifecycleAction, string> = {
  publish: "Publish",
  archive: "Archive",
  restore: "Restore",
};
const diagnosticSummary = (diagnostics: ReadonlyArray<RoutineValidationDiagnostic>): string =>
  diagnostics.map((diagnostic) => diagnostic.message).join(" ");
const withRationale = (summary: string, rationale?: string): string => rationale ? `${summary} ${rationale}` : summary;
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
// includesDefinition/includesEnablement are optional so a targetRef persisted before this field
// existed still parses; readCurrentVersionParts treats an absent flag as "true" (the old,
// coarser behavior of always gating on both rows) rather than as "false". See the comment on
// readVersionToken for why the version token needs this at all.
const contextVariableTargetRefSchema = z.object({
  agentId: z.string().uuid(),
  variableId: z.string().uuid().nullable(),
  includesDefinition: z.boolean().optional(),
  includesEnablement: z.boolean().optional(),
}).strict();
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
    if (isDirectiveEnablement(payload)) {
      if (!current) {
        return {
          targetLabel: payload.name ?? "Directive",
          current: null,
          proposed: DIRECTIVE_ENABLEMENT_TARGET_MISSING_NOTICE,
        };
      }
      return { targetLabel: current.name, current, proposed: { ...current, enabled: payload.enabled } };
    }
    const proposed = directivePayload(payload);
    return { targetLabel: proposed.name, current, proposed };
  },
  async applyIfVersionMatches(workspaceId, rawTargetRef, payload, token) {
    const targetRef = directiveTargetRefSchema.parse(rawTargetRef);
    if (isDirectiveRemoval(payload)) {
      if (!targetRef.directiveId) return { outcome: "failed" as const, reason: "Directive removal requires an existing directive" };
      try {
        // The version check lives in the delete call itself (expectedUpdatedAt reaches the
        // repository's DELETE predicate), not in a read-then-compare here: a pre-read leaves a
        // window where a concurrent edit lands between the check and the delete and gets destroyed.
        await deps.authoredDirectiveService.delete(workspaceId, targetRef.agentId, targetRef.directiveId, { expectedUpdatedAt: versionDate(token) });
        return { outcome: "applied" as const, appliedRef: { directiveId: targetRef.directiveId } };
      } catch (error) {
        if (isStale(error)) return { outcome: "stale" as const };
        return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Directive removal failed" };
      }
    }
    if (isDirectiveEnablement(payload)) {
      if (!targetRef.directiveId) return { outcome: "failed" as const, reason: "Directive enablement requires an existing directive" };
      try {
        const directive = (await deps.authoredDirectiveService.update(
          workspaceId,
          targetRef.agentId,
          targetRef.directiveId,
          { enabled: payload.enabled },
          { expectedUpdatedAt: versionDate(token) },
        )).directive;
        return { outcome: "applied" as const, appliedRef: { directiveId: directive.id } };
      } catch (error) {
        if (isStale(error)) return { outcome: "stale" as const };
        return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Directive enablement failed" };
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
    // The version token is derived from this same read, not a follow-up readVersionToken call: a
    // concurrent edit landing between two separate reads could pair a merge built from the first
    // (now stale) read with the second read's fresher token, letting a lost update pass its
    // version check on Apply.
    const current = await deps.agentService.get(workspaceId, targetRef.agentId);
    const patch = settingPatch(targetRef.settingKey, payload.value);
    const merged = { ...current, ...patch, surfaceSettings: patch.surfaceSettings ? mergeAgentSurfaceSettings(current.surfaceSettings, patch.surfaceSettings) : current.surfaceSettings };
    const normalized = validateAgentInput(merged);
    if (!Object.hasOwn(normalized, targetRef.settingKey)) throw new Error("Unknown agent setting");
    return { targetRef, payload: { ...payload, value: settingValue(normalized, targetRef.settingKey) }, versionToken: versionToken(current.updatedAt) };
  },
});

/**
 * Composition adapter: a skill config is supplied by Ray from settings it already read, not
 * drafted from prose, so validation happens entirely in `validatePayload` against the real
 * capability registry — the same registry the agent_skills reader lists settingsFields from.
 */
export const createAgentSkillCopilotProposalAdapter = (deps: {
  readonly agentService: Pick<AgentService, "get">;
  readonly agentSkillsService: Pick<AgentSkillsService, "list" | "create" | "update" | "dryRunValidate">;
  readonly skillCapabilityRegistry: SkillCapabilityRegistry;
}): CopilotAgentSkillProposalAdapter => {
  const findExisting = async (workspaceId: string, agentId: string, skillId: string | null): Promise<AgentSkillView | null> => {
    if (!skillId) return null;
    const skills = await deps.agentSkillsService.list(workspaceId, agentId);
    return skills.find((skill) => skill.id === skillId) ?? null;
  };

  /**
   * Whichever existing skill would make `create()`'s own uniqueness checks - a name collision, or
   * (only when the proposal is itself default_answer) the one-default-answer-skill-per-agent
   * constraint - reject the create this proposal describes, or null when none would.
   */
  const blockingSkillForCreate = (
    skills: ReadonlyArray<AgentSkillView>,
    name: string,
    invocationMode: string,
  ): AgentSkillView | null =>
    skills.find((skill) => skill.name === name)
      ?? (invocationMode === "default_answer" ? skills.find((skill) => skill.invocationMode === "default_answer") ?? null : null);

  /**
   * A create proposal's version token: which existing skill (if any) already blocks it, read
   * fresh both when the proposal is drafted (to seed its stored token) and again at GET time (to
   * recompute it), so the two only diverge when that specific conflict changes - never from an
   * unrelated agent edit. The agent is still resolved for its own sake (an unresolvable id must
   * fail here, not only once Apply's write is attempted), just no longer used for the token.
   */
  const createSkillVersionToken = async (workspaceId: string, agentId: string, name: string, invocationMode: string): Promise<string> => {
    await deps.agentService.get(workspaceId, agentId);
    const skills = await deps.agentSkillsService.list(workspaceId, agentId);
    const blocking = blockingSkillForCreate(skills, name, invocationMode);
    return blocking ? `blocked:${blocking.id}:${versionToken(new Date(blocking.updatedAt))}` : "open";
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

    // Deliberately not re-validated here: capability config schema, target-kind match,
    // invocation-mode support, and default-answer uniqueness are AgentSkillsService's own rules.
    // dryRunValidate runs exactly the same validation create/update do - including the schema
    // shape a previous fix used to re-check locally with agentSkillCreateSchema/agentSkillUpdateSchema
    // - without persisting, so a configuration the service would reject on Apply (wrong target
    // kind, a second default-answer skill, ...) is refused here instead of becoming a pending
    // proposal card that can only fail once applied.
    const invocationMode = payload.invocationMode ?? existing?.invocationMode ?? descriptor.defaultInvocationMode ?? descriptor.supportedInvocationModes[0];
    const target = payload.target ?? existing?.target ?? { kind: descriptor.targetKind, id: null };
    const enabled = payload.enabled ?? existing?.enabled ?? true;
    const validatedConfig = await deps.agentSkillsService.dryRunValidate(
      workspaceId,
      targetRef.agentId,
      { name, capability: descriptor.id, target, config, invocationMode: invocationMode as string, enabled },
      existing?.id,
    );

    // For an update, derived from `existing` - the same read this function already used to expand
    // the partial patch above - rather than a follow-up readVersionToken call. A second, separate
    // read would leave a window where a concurrent edit lands between the two: the payload above
    // would still reflect the first (now stale) read, but the token would reflect the second, so
    // Apply's version check would pass and overwrite whatever changed in between. For a create,
    // see the comment on createSkillVersionToken for why this isn't the agent's updatedAt either.
    const proposalVersionToken = existing
      ? versionToken(new Date(existing.updatedAt))
      : await createSkillVersionToken(workspaceId, targetRef.agentId, name, invocationMode as string);

    return {
      existing,
      versionToken: proposalVersionToken,
      normalized: {
        name,
        capability: descriptor.id,
        target,
        config: validatedConfig,
        invocationMode: invocationMode as AgentSkillInvocationMode,
        enabled,
        ...(payload.rationale ? { rationale: payload.rationale } : {}),
      },
    };
  };

  /** Projects a stored skill down to the same editable shape a proposal's payload carries, so a
   * preview diff shows only fields the proposal can actually change - not identity/audit columns
   * (id, createdAt, updatedAt, ...) that render as spurious "removed" rows next to a payload that
   * never carried them in the first place. */
  const projectSkillForPreview = (skill: AgentSkillView) => ({
    name: skill.name,
    capability: skill.capability,
    target: skill.target,
    config: skill.config,
    invocationMode: skill.invocationMode,
    enabled: skill.enabled,
  });

  /** Same projection as projectSkillForPreview, applied to the stored payload's `proposed` side.
   * `rationale` is presentation-only (Apply never writes it — AgentSkillsService.update/.create
   * take no such field), so passing the payload through whole would render it in the diff as a
   * config value the proposal adds, the same class of leak already fixed for identity/audit
   * columns on the current side and for the untouched context-variable half (Finding 3, issue
   * triage next-ray-epic-issue). */
  const projectSkillPayloadForPreview = (payload: z.infer<typeof skillConfigStoredPayloadSchema>) => ({
    name: payload.name,
    capability: payload.capability,
    target: payload.target,
    config: payload.config,
    invocationMode: payload.invocationMode,
    enabled: payload.enabled,
  });

  return {
    targetType: "agent_skill",
    async readVersionToken(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = skillTargetRefSchema.parse(rawTargetRef);
      if (targetRef.skillId) {
        const existing = await findExisting(workspaceId, targetRef.agentId, targetRef.skillId);
        if (!existing) throw notFound("Skill no longer exists");
        return versionToken(new Date(existing.updatedAt));
      }
      const payload = skillConfigStoredPayloadSchema.parse(rawPayload);
      return createSkillVersionToken(workspaceId, targetRef.agentId, payload.name, payload.invocationMode);
    },
    async preview(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = skillTargetRefSchema.parse(rawTargetRef);
      const payload = skillConfigStoredPayloadSchema.parse(rawPayload);
      const existing = await findExisting(workspaceId, targetRef.agentId, targetRef.skillId);
      return { targetLabel: payload.name, current: existing ? projectSkillForPreview(existing) : null, proposed: projectSkillPayloadForPreview(payload) };
    },
    async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
      const targetRef = skillTargetRefSchema.parse(rawTargetRef);
      const payload = skillConfigStoredPayloadSchema.parse(rawPayload);
      try {
        if (targetRef.skillId) {
          // The version check lives in the update call itself (expectedUpdatedAt reaches the
          // repository's UPDATE predicate), not in a read-then-compare here: a pre-read leaves a
          // window where a concurrent edit lands between the check and the write and is overwritten.
          const updated = await deps.agentSkillsService.update(workspaceId, targetRef.agentId, targetRef.skillId, {
            target: payload.target,
            replaceConfig: payload.config,
            invocationMode: payload.invocationMode as AgentSkillInvocationMode,
            enabled: payload.enabled,
          }, { expectedUpdatedAt: versionDate(token) });
          return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, skillId: updated.id } };
        }
        // Resolved for its own sake (agent_skills.agent_id's foreign key only proves the id
        // exists somewhere, not that it belongs to this workspace), not to gate on its
        // updatedAt: a create never touches the agent row, so comparing timestamps here could
        // only ever produce a false "stale" from an unrelated agent edit - never real protection
        // against replaying an apply that already succeeded. That protection comes from the
        // service's own name-uniqueness check below, which raises a real conflict.
        await deps.agentService.get(workspaceId, targetRef.agentId);
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
      const { normalized, versionToken: proposalVersionToken } = await resolveProposal(workspaceId, targetRef, rawPayload);
      return { targetRef, payload: normalized, versionToken: proposalVersionToken };
    },
  };
};

/**
 * Composition adapter for routines: translates Copilot proposals into the routine module's
 * authoring and lifecycle operations. It owns proposal-specific preview and stale-card behavior;
 * the routine service remains authoritative for which lifecycle transitions may go live.
 */
export const createRoutineCopilotProposalAdapter = (deps: {
  readonly agentService: Pick<AgentService, "get">;
  readonly routineDraftAssistService: Pick<RoutineDraftAssistService, "draft">;
  readonly routineDefinitionService: Pick<RoutineDefinitionService, "createDraft" | "deleteDraft" | "get" | "list" | "updateDraft" | "revise" | "publish" | "archive" | "restore" | "validate">;
  readonly logger?: { warn(fields: Record<string, unknown>, message: string): void };
}): CopilotRoutineProposalAdapter => {
  const routineFor = async (workspaceId: string, targetRef: { agentId: string; routineId: string | null }) =>
    deps.routineDefinitionService.get(workspaceId, targetRef.agentId, requiredRoutineId(targetRef));

  /**
   * A create proposal's version token: whichever routine already occupies the (name, version 1)
   * identity a fresh createDraft would take - the routine_definition_agent_id_name_version_key
   * constraint createDraft's own catch translates into a conflict - or null when none does. Read
   * fresh both when the proposal is drafted (to seed its stored token) and again at GET time (to
   * recompute it), so the two only diverge when that specific conflict changes - never from an
   * unrelated agent edit. The agent is still resolved for its own sake (an unresolvable id must
   * fail here, not only once Apply's write is attempted), just no longer used for the token.
   */
  const createRoutineVersionToken = async (workspaceId: string, agentId: string, name: string): Promise<string> => {
    await deps.agentService.get(workspaceId, agentId);
    const routines = await deps.routineDefinitionService.list(workspaceId, agentId);
    const blocking = routines.find((routine) => routine.name === name && routine.version === 1) ?? null;
    return blocking ? `blocked:${blocking.id}:${versionToken(blocking.updatedAt)}` : "open";
  };

  /**
   * The draft revision of a published routine's lineage, if one exists.
   *
   * Two writes turn on this: revising a published routine hands back an existing draft rather than
   * a fresh copy, and archiving deletes it. Both would otherwise destroy work the operator never
   * saw named.
   */
  const draftRevisionOf = async (workspaceId: string, agentId: string, routine: RoutineDefinition) =>
    (await deps.routineDefinitionService.list(workspaceId, agentId))
      .find((candidate) => candidate.lineageId === routine.lineageId && candidate.status === "draft" && candidate.id !== routine.id) ?? null;

  /**
   * Existing-routine proposals are stale when either the addressed row or unpublished work that
   * their decision depends on moves. A published routine can have a draft sibling: edits must not
   * overwrite it, and archives must disclose exactly what they discard. Keep the legacy single-row
   * token when there is no sibling so already-persisted proposals without that dependency remain
   * comparable after deployment.
   */
  const proposalVersionToken = async (
    workspaceId: string,
    targetRef: { agentId: string; routineId: string | null },
    routine: RoutineDefinition,
  ): Promise<string> => {
    const draftRevision = routine.status === "published"
      ? await draftRevisionOf(workspaceId, targetRef.agentId, routine)
      : null;
    if (!draftRevision) return versionToken(routine.updatedAt);
    return JSON.stringify({
      routineUpdatedAt: versionToken(routine.updatedAt),
      draftRevision: {
        id: draftRevision.id,
        updatedAt: versionToken(draftRevision.updatedAt),
      },
    });
  };

  return {
    targetType: "routine",
    async readVersionToken(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = routineTargetRefSchema.parse(rawTargetRef);
      // See the comment on createRoutineVersionToken for why a new routine's token is not the
      // agent's updatedAt; an existing one still guards itself.
      if (!targetRef.routineId) return createRoutineVersionToken(workspaceId, targetRef.agentId, routinePayload(rawPayload).name);
      const routine = await routineFor(workspaceId, targetRef);
      return proposalVersionToken(workspaceId, targetRef, routine);
    },
    async preview(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = routineTargetRefSchema.parse(rawTargetRef);
      const kind = routinePayloadKind(rawPayload);
      if (kind === "create") {
        const proposed = routinePayload(rawPayload);
        return { targetLabel: proposed.name, current: null, proposed: projectRoutineForReview(proposed) };
      }
      const routine = await routineFor(workspaceId, targetRef).catch(() => null);
      if (kind === "lifecycle") {
        const payload = routineLifecyclePayloadSchema.parse(rawPayload);
        const discarded = routine && payload.action === "archive"
          ? await draftRevisionOf(workspaceId, targetRef.agentId, routine)
          : null;
        return {
          targetLabel: routine?.name ?? payload.name,
          current: routine ? { status: routine.status } : null,
          proposed: {
            status: routineStatusAfterAction[payload.action],
            ...(discarded ? { discardsDraftRevision: `${discarded.name} (draft, version ${discarded.version})` } : {}),
          },
        };
      }
      const payload = routineEditPayloadSchema.parse(rawPayload);
      if (!routine) return { targetLabel: payload.name, current: null, proposed: { editNoLongerApplies: "This routine no longer exists." } };
      try {
        return {
          targetLabel: routine.name,
          current: projectRoutineForReview(routine),
          proposed: projectRoutineForReview(applyRoutineFieldPatch(routine, payload.changes)),
        };
      } catch (error) {
        // The routine moved under the proposal. The version token already marks the card stale;
        // this says which part of the edit no longer has anything to address.
        return { targetLabel: routine.name, current: null, proposed: { editNoLongerApplies: error instanceof Error ? error.message : "This edit no longer applies." } };
      }
    },
    async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
      const targetRef = routineTargetRefSchema.parse(rawTargetRef);
      const kind = routinePayloadKind(rawPayload);
      try {
        if (kind === "create") {
          // No pre-read version check here: createDraft never touches the agent row, so
          // comparing the agent's updatedAt against the token could only ever produce a false
          // "stale" from an unrelated agent edit - never real protection against replaying an
          // apply that already succeeded. That protection comes from createDraft's own
          // name+version uniqueness check (routine_definition_agent_id_name_version_key), which
          // RoutineDefinitionService.createDraft already turns into a real conflict - caught
          // below by isStale, the same way every other version check in this file is enforced by
          // the write itself rather than a read-then-compare.
          const result = await deps.routineDefinitionService.createDraft(workspaceId, targetRef.agentId, routinePayload(rawPayload));
          // The card deep-links from appliedRef alone when the proposal detail was
          // never loaded, so the agent id must travel with the routine id.
          return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, routineId: result.routine.id } };
        }
        const routine = await routineFor(workspaceId, targetRef);
        if (await proposalVersionToken(workspaceId, targetRef, routine) !== token) return { outcome: "stale" as const };
        if (kind === "lifecycle") {
          const payload = routineLifecyclePayloadSchema.parse(rawPayload);
          if (payload.action === "restore") {
            const validation = await deps.routineDefinitionService.validate(workspaceId, targetRef.agentId, { id: routine.id });
            if (!validation.ok) {
              return { outcome: "failed" as const, reason: `${routine.name} cannot be restored: ${diagnosticSummary(validation.diagnostics)}` };
            }
          }
          if (payload.action === "archive") {
            const discarded = await draftRevisionOf(workspaceId, targetRef.agentId, routine);
            const disclosed = discarded?.id === payload.discardsDraftRevisionId
              && discarded?.updatedAt.toISOString() === payload.discardsDraftRevisionUpdatedAt;
            if (!disclosed) {
              return {
                outcome: "failed" as const,
                reason: discarded
                  ? `The draft revision archiving ${routine.name} would delete (version ${discarded.version}) is not the one this card described. Draft the archive again so it says what would be lost.`
                  : `The draft revision this card offered to discard is already gone. Draft the archive again.`,
              };
            }
          }
          // Awaited inside the try on purpose: returning the promise would let its rejection past
          // the catch below, and a lifecycle failure would surface as an unhandled route error
          // instead of a failed proposal.
          return await applyRoutineLifecycle(deps, workspaceId, targetRef.agentId, routine, payload.action, payload.discardsDraftRevisionId
            ? { id: payload.discardsDraftRevisionId, updatedAt: new Date(payload.discardsDraftRevisionUpdatedAt!) }
            : null);
        }
        const payload = routineEditPayloadSchema.parse(rawPayload);
        if (!editableRoutineStatus(routine)) return { outcome: "failed" as const, reason: uneditableRoutineReason(routine) };
        // Editing a published routine edits a fresh revision of it. Nothing an operator applies
        // here changes what the agent is serving; that takes a separate publish proposal.
        if (routine.status === "draft") {
          await deps.routineDefinitionService.updateDraft(
            workspaceId,
            targetRef.agentId,
            routine.id,
            applyRoutineFieldPatch(routine, payload.changes),
            { expectedUpdatedAt: routine.updatedAt },
          );
          return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, routineId: routine.id } };
        }
        // A draft revision holding work the operator never saw would be handed back by revise() and
        // patched from the published content, replacing what is in it. An untouched revision is a
        // verbatim copy of this routine, so reusing it changes nothing.
        const pending = await draftRevisionOf(workspaceId, targetRef.agentId, routine);
        if (pending && !sameAuthoredContent(pending, routine)) return { outcome: "stale" as const };
        const revision = await deps.routineDefinitionService.revise(workspaceId, targetRef.agentId, routine.id);
        // Belt and braces for the window between the check above and revise(): a draft created in
        // between comes back here, and anything already changed in it fails this comparison.
        if (!sameAuthoredContent(revision, routine)) return { outcome: "stale" as const };
        // A revision left behind by a failed edit is a verbatim copy of the published routine, the
        // same thing an author leaves behind by revising and walking away. The next edit reuses it
        // rather than tripping over it, so this deliberately does not try to take it back: a
        // clean-up racing whoever else may hold that draft is worse than an untouched copy.
        await deps.routineDefinitionService.updateDraft(
          workspaceId,
          targetRef.agentId,
          revision.id,
          applyRoutineFieldPatch(revision, payload.changes),
          { expectedUpdatedAt: revision.updatedAt },
        );
        return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, routineId: revision.id } };
      } catch (error) {
        if (isStale(error)) return { outcome: "stale" as const };
        return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Routine change failed" };
      }
    },
    async draft(workspaceId, rawTargetRef, intent) {
      const targetRef = routineTargetRefSchema.parse(rawTargetRef);
      const result = await deps.routineDraftAssistService.draft(workspaceId, targetRef.agentId, { prose: intent });
      const diagnostics = result.validation.diagnostics;
      const summary = diagnostics.length === 0
        ? `Draft routine ${result.draft.name}.`
        : `Draft routine ${result.draft.name} has ${diagnostics.length} open validation diagnostic${diagnostics.length === 1 ? "" : "s"}.`;
      // The card summary is rebuilt from payload.rationale after a reload, so
      // the summary rides the stored payload the same way directive drafts do.
      return { payload: { ...result.draft, rationale: summary }, targetLabel: result.draft.name, summary, diagnostics };
    },
    async draftEdit(workspaceId, rawTargetRef, rawChanges, rationale) {
      const targetRef = routineTargetRefSchema.parse(rawTargetRef);
      const changes = routineFieldPatchSchema.parse(rawChanges);
      const routine = await routineFor(workspaceId, targetRef);
      if (!editableRoutineStatus(routine)) throw new Error(uneditableRoutineReason(routine));
      // A draft revision blocks this edit only when it holds work: revising a published routine
      // copies it verbatim, so a revision nobody has touched yet is the routine, and reusing it is
      // what applying this edit will do. Refusing on its mere existence would strand the routine
      // whenever a revision was created and abandoned.
      const pendingRevision = routine.status === "published" ? await draftRevisionOf(workspaceId, targetRef.agentId, routine) : null;
      if (pendingRevision && !sameAuthoredContent(pendingRevision, routine)) {
        throw new Error(`Routine ${routine.name} already has a draft revision (version ${pendingRevision.version}) with unpublished changes in it. Edit that draft, so this change lands on top of them rather than replacing them.`);
      }
      const patched = applyRoutineFieldPatch(routine, changes);
      const before = await deps.routineDefinitionService.validate(workspaceId, targetRef.agentId, { id: routine.id });
      const after = await deps.routineDefinitionService.validate(workspaceId, targetRef.agentId, { input: patched });
      // Only diagnostics this edit *introduces* block it. A routine that was already failing
      // validation must stay editable, or the one change that would fix it cannot be proposed.
      const carried = new Set(before.diagnostics.map(diagnosticIdentity));
      const introduced = after.diagnostics.filter((diagnostic) => !carried.has(diagnosticIdentity(diagnostic)));
      if (introduced.length > 0) throw new Error(`This edit would break ${routine.name}: ${diagnosticSummary(introduced)}`);
      const summary = withRationale(`Edit routine ${routine.name}: ${describeRoutineFieldPatch(changes)}.`, rationale);
      return {
        payload: { kind: "edit", name: routine.name, changes, rationale: summary },
        targetLabel: routine.name,
        summary,
        diagnostics: after.diagnostics,
      };
    },
    async draftLifecycle(workspaceId, rawTargetRef, action, rationale) {
      const targetRef = routineTargetRefSchema.parse(rawTargetRef);
      const routine = await routineFor(workspaceId, targetRef);
      const required = routineStatusForAction[action];
      if (routine.status !== required) {
        const pending = action === "publish" && routine.status === "published"
          ? await draftRevisionOf(workspaceId, targetRef.agentId, routine)
          : null;
        throw new Error(pending
          ? `Routine ${routine.name} is already published. Its draft revision (version ${pending.version}) is what there is to publish.`
          : `Routine ${routine.name} is ${routine.status}; only a routine that is ${required} can be ${action}ed.`);
      }
      // Publish and restore both put a routine in front of customers. The service owns the
      // authoritative gate; this earlier check keeps an invalid proposal from reaching the card.
      const diagnostics = goesLive(action)
        ? (await deps.routineDefinitionService.validate(workspaceId, targetRef.agentId, { id: routine.id })).diagnostics
        : [];
      if (diagnostics.length > 0) {
        throw new Error(`Routine ${routine.name} cannot be ${action}ed yet: ${diagnosticSummary(diagnostics)}`);
      }
      // Archiving deletes the lineage's draft revision. The operator has to be told that before
      // they apply, because nothing restores it afterwards.
      const discarded = action === "archive" ? await draftRevisionOf(workspaceId, targetRef.agentId, routine) : null;
      const summary = withRationale(
        `${routineActionVerb[action]} routine ${routine.name}.${discarded ? ` This discards its draft revision (version ${discarded.version}).` : ""}`,
        rationale,
      );
      return {
        payload: {
          kind: "lifecycle",
          action,
          name: routine.name,
          rationale: summary,
          ...(discarded ? { discardsDraftRevisionId: discarded.id, discardsDraftRevisionUpdatedAt: discarded.updatedAt.toISOString() } : {}),
        },
        targetLabel: routine.name,
        summary,
        diagnostics,
      };
    },
  };
};

/**
 * Identifies a diagnostic across an edit. Locations address stable ids, except routine-level ones,
 * which carry the routine's name — so renaming a routine would otherwise look like it introduced
 * every routine-level diagnostic the routine already had, and block the rename.
 */
const diagnosticIdentity = (diagnostic: RoutineValidationDiagnostic): string =>
  `${diagnostic.code}@${diagnostic.location.startsWith("routine:") ? "routine:" : diagnostic.location}`;

// Compares what an author can change, ignoring identity and timestamps: two routines match when
// applying the same edit to either produces the same result.
const sameAuthoredContent = (left: RoutineDefinition, right: RoutineDefinition): boolean =>
  JSON.stringify(projectRoutineForReview(left)) === JSON.stringify(projectRoutineForReview(right));

const applyRoutineLifecycle = async (
  deps: {
    readonly routineDefinitionService: Pick<RoutineDefinitionService, "publish" | "archive" | "restore" | "list">;
    readonly logger?: { warn(fields: Record<string, unknown>, message: string): void };
  },
  workspaceId: string,
  agentId: string,
  routine: RoutineDefinition,
  action: CopilotRoutineLifecycleAction,
  discardsDraftRevision: { id: string; updatedAt: Date } | null = null,
): Promise<{ outcome: "applied"; appliedRef: unknown } | { outcome: "failed"; reason: string }> => {
  try {
    if (action === "publish") {
      // The token was checked against this row a moment ago; stating it in the write is what stops a
      // save landing in between from going live unreviewed.
      const result = await deps.routineDefinitionService.publish(workspaceId, agentId, routine.id, { expectedUpdatedAt: routine.updatedAt });
      if ("rejected" in result) {
        return { outcome: "failed", reason: `${routine.name} could not be published: ${diagnosticSummary(result.validation.diagnostics)}` };
      }
      return { outcome: "applied", appliedRef: { agentId, routineId: result.routine.id } };
    }
    if (action === "archive") {
      // Stating the disclosed draft here puts the precondition inside the archive transaction, where
      // a revision created a moment ago cannot slip past it and be deleted unannounced.
      const moved = await deps.routineDefinitionService.archive(workspaceId, agentId, routine.id, { expectedDraftRevision: discardsDraftRevision });
      return { outcome: "applied", appliedRef: { agentId, routineId: moved.id } };
    }
    const result = await deps.routineDefinitionService.restore(workspaceId, agentId, routine.id);
    if ("rejected" in result) {
      return { outcome: "failed", reason: `${routine.name} could not be restored: ${diagnosticSummary(result.validation.diagnostics)}` };
    }
    return { outcome: "applied", appliedRef: { agentId, routineId: result.routine.id } };
  } catch (error) {
    // A conflict is the write refusing before it committed — the version moved, or the draft this
    // archive described did. Nothing happened, so say so rather than looking at the routine: by
    // then another writer may have made the same transition, and this proposal would take credit
    // for content its own write never put live.
    if (isStale(error)) throw error;
    if (
      error instanceof RoutineDefinitionLifecycleCommittedError &&
      error.action === action &&
      error.routineId === routine.id
    ) {
      deps.logger?.warn({
        err: error.cause,
        workspaceId,
        agentId,
        routineId: routine.id,
        action,
      }, "Routine lifecycle committed but follow-up work failed");
      return { outcome: "applied", appliedRef: { agentId, routineId: routine.id } };
    }
    throw error;
  }
};

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

interface DirectiveEnablementPayload {
  readonly op: "set_enabled";
  readonly enabled: boolean;
  /** Presentation-only, as on a removal payload. */
  readonly name?: string;
  readonly rationale?: string;
}

// A payload missing `op` is the save shape every proposal used before removal existed, so it must
// keep reading as a save. Only an explicit `op: "remove"` selects the removal branch.
const isDirectiveRemoval = (payload: unknown): payload is DirectiveRemovalPayload =>
  typeof payload === "object" && payload !== null && (payload as { op?: unknown }).op === "remove";

const isDirectiveEnablement = (payload: unknown): payload is DirectiveEnablementPayload =>
  typeof payload === "object"
  && payload !== null
  && (payload as { op?: unknown }).op === "set_enabled"
  && typeof (payload as { enabled?: unknown }).enabled === "boolean";

/**
 * Shown as the "proposed" side of a removal's preview. A plain notice reads far more clearly than
 * the generic diff algorithm's default for a record `current` next to a null/undefined `proposed`:
 * recursing into every field of the directive and marking each one individually removed.
 */
const DIRECTIVE_REMOVAL_NOTICE = "This directive will be permanently removed.";

/**
 * Shown when a directive changed after an enablement proposal was drafted. A plain notice avoids
 * the generic diff algorithm trying to compare an absent record against a partial replacement.
 */
const DIRECTIVE_ENABLEMENT_TARGET_MISSING_NOTICE = "This directive no longer exists, so this change cannot be applied.";

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
    surfaces: z.array(z.string()).optional(),
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

/**
 * A context-variable proposal's version token encodes two independently-versioned timestamps
 * (the variable's own `updatedAt`, and this agent's enablement `updatedAt`) rather than the
 * single ISO string every other target type's token is. See the comment on
 * readCurrentVersionParts for why a single combined value can't do this job.
 *
 * Either side is `null` both when the underlying row does not exist yet (a brand-new variable's
 * enablement, say) and when the proposal this token belongs to never touches that side at all
 * (an enablement-only update to an existing variable's `variableUpdatedAt`). The two cases share
 * an encoding on purpose: Apply already ignores whichever half its own payload does not write
 * (`applyProposal` only checks `expectedVariableUpdatedAt`/`expectedEnablementUpdatedAt` when the
 * matching `definition`/`enablement` input is present), so a GET-time recompute of this token
 * needs to omit that same half to agree with Apply about what "stale" means - otherwise a
 * definition-only proposal drafted after an unrelated enablement edit would report stale here
 * while still applying successfully.
 *
 * The variable half is not always a Date: a create names no row of its own to read one from, so
 * its half is instead the opaque string contextVariableCreateToken produces. That's safe to mix
 * in here because applyIfVersionMatches never decodes this half back into a Date for a create -
 * expectedVariableUpdatedAt is unconditionally null there (variableId is null; there is no prior
 * row to version-gate against) - so decodeContextVariableVersionToken only ever needs to split
 * this half out, never parse it.
 */
const encodeContextVariableVersionToken = (variablePart: Date | string | null, enablementUpdatedAt: Date | null): string =>
  `${typeof variablePart === "string" ? variablePart : variablePart ? variablePart.toISOString() : ""}|${enablementUpdatedAt ? enablementUpdatedAt.toISOString() : ""}`;

/**
 * The definition half of a create proposal's token: which existing variable (if any) already
 * occupies the workspace+name identity a fresh insert would take - the
 * context_variables_workspace_id_name_key constraint applyProposal's own catch translates into a
 * conflict (see isContextVariableNameConflict in contextVariableRepository.ts) - or "open" when
 * none does. Read fresh both when a create proposal is drafted (to seed its stored token) and
 * again at GET time (to recompute it), so the two only diverge when that specific conflict
 * changes - never from an unrelated agent edit.
 */
const contextVariableCreateToken = (blocking: ContextVariable | null): string =>
  blocking ? `blocked:${blocking.id}:${blocking.updatedAt.toISOString()}` : "open";

const decodeContextVariableVersionToken = (token: string): { variableUpdatedAt: Date | null; enablementUpdatedAt: Date | null } => {
  const [variablePart, enablementPart] = token.split("|");
  return {
    variableUpdatedAt: variablePart ? new Date(variablePart) : null,
    enablementUpdatedAt: enablementPart ? new Date(enablementPart) : null,
  };
};

const isSkillCapabilityId = (value: string): value is SkillCapabilityId => (skillCapabilityIds as readonly string[]).includes(value);

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Applies always end up as a full `replaceConfig` (see the comment on `dryRunValidate`'s call
// site), so whatever `mergeSkillConfig` (shared with the direct HTTP PATCH path in
// AgentSkillRepository - see backend/src/modules/agentSkills/configMerge.ts) produces here IS the
// config that gets persisted - there is no service-side partial merge left to fall back on.

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
  readonly contextVariableRepository: Pick<ContextVariableRepositoryPort, "get" | "listByAgent" | "listByWorkspace" | "applyProposal">;
  readonly agentSkillsService: Pick<AgentSkillsService, "list">;
}): CopilotContextVariableProposalAdapter => {
  const findEnablement = (workspaceId: string, agentId: string, variableId: string | null) =>
    findAgentContextVariableEnablement(deps.contextVariableRepository, workspaceId, agentId, variableId);

  const findBlockingVariable = async (workspaceId: string, name: string): Promise<ContextVariable | null> => {
    const variables = await deps.contextVariableRepository.listByWorkspace(workspaceId);
    return variables.find((variable) => variable.name === name) ?? null;
  };

  /** Projects a stored definition/enablement down to the same editable shape a proposal's
   * payload carries, so a preview diff shows only fields a proposal can actually change - not
   * identity/audit columns (id, workspaceId, createdAt, updatedAt, ...) that would otherwise
   * render as spurious "removed" rows next to a payload that never carried them. */
  const projectDefinitionForPreview = (definition: Pick<ContextVariable, "name" | "description" | "valueType" | "trustTier" | "sensitivity" | "defaultSurfacing">) => ({
    name: definition.name,
    description: definition.description,
    valueType: definition.valueType,
    trustTier: definition.trustTier,
    sensitivity: definition.sensitivity,
    defaultSurfacing: definition.defaultSurfacing,
  });
  const projectEnablementForPreview = (enablement: Pick<AgentContextVariableEnablement, "source" | "resolverSkillId" | "maxAgeSeconds" | "resolverTimeoutMs" | "surfacing" | "enabled">) => ({
    source: enablement.source,
    resolverSkillId: enablement.resolverSkillId,
    maxAgeSeconds: enablement.maxAgeSeconds,
    resolverTimeoutMs: enablement.resolverTimeoutMs,
    surfacing: enablement.surfacing,
    enabled: enablement.enabled,
  });

  // A proposal can touch the definition, the enablement, or both — two independently-versioned
  // rows behind a single proposal. A single `max(...)` timestamp token can't be decomposed back
  // into two per-row expectations (whichever side did NOT change would still fail its own
  // WHERE-clause guard when the token derives from the other side's later timestamp), so the
  // token carries both timestamps explicitly instead.
  /** For an existing variable only; a create has no row of its own to read from - see readVersionToken's create branch. */
  const readCurrentVersionParts = async (
    workspaceId: string,
    targetRef: { agentId: string; variableId: string },
  ): Promise<{ variableUpdatedAt: Date; enablementUpdatedAt: Date | null }> => {
    // agent_context_variables.agent_id carries no foreign key (see migration 112), so resolving
    // the agent through the workspace here is the only thing standing between a hallucinated or
    // cross-workspace agent id and an orphan enablement row. Matches the requireAgent check
    // contextVariableRoutes.ts runs on every write.
    await deps.agentService.get(workspaceId, targetRef.agentId);
    const variable = await deps.contextVariableRepository.get(workspaceId, targetRef.variableId);
    if (!variable) throw notFound("Context variable no longer exists");
    const enablement = await findEnablement(workspaceId, targetRef.agentId, targetRef.variableId);
    return { variableUpdatedAt: variable.updatedAt, enablementUpdatedAt: enablement?.updatedAt ?? null };
  };

  const resolveProposal = async (workspaceId: string, targetRef: { agentId: string; variableId: string | null }, rawPayload: unknown) => {
    const payload = contextVariableProposalPayloadSchema.parse(rawPayload);
    // Resolved for its own sake: a proposal always scopes to an agent (even a definition-only
    // one), so an unresolvable agent id must fail here rather than only surfacing once the
    // enablement write is attempted. Not used for the version token below - see the comment on
    // contextVariableCreateToken for what a create's half is derived from instead.
    await deps.agentService.get(workspaceId, targetRef.agentId);
    const existing = targetRef.variableId ? await deps.contextVariableRepository.get(workspaceId, targetRef.variableId) : null;
    if (targetRef.variableId && !existing) throw notFound("Context variable not found");
    // Read in the same pass as `existing`, both to close the same stale-read window Finding 1
    // closes for the definition side, and because it doubles as the version-token anchor for an
    // enablement-only proposal (see the versionToken computation below).
    const existingEnablement = await findEnablement(workspaceId, targetRef.agentId, targetRef.variableId);

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

      // A create, or a rename, that would collide with another variable's workspace+name identity
      // (context_variables_workspace_id_name_key) can never apply - refusing it here, at draft
      // time, is what keeps that always-doomed proposal from ever becoming a pending card (Findings
      // 1-2, next-ray-epic-issue review). Skipped when the name is unchanged so an update that
      // leaves it alone never pays for this read. A blocker that appears only *after* this check -
      // racing a create (contextVariableCreateToken, read fresh again at GET time) or a rename
      // (applyProposal's own translated unique-constraint conflict) - is still caught, just later.
      if (name !== existing?.name) {
        const blocking = await findBlockingVariable(workspaceId, name);
        if (blocking && blocking.id !== existing?.id) {
          throw conflict(`A context variable named "${name}" already exists for this workspace`);
        }
      }
    }

    let enablement: NormalizedContextVariableEnablement | null = null;
    if (payload.enablement) {
      const rawEnablement = payload.enablement;
      // ApplyContextVariableProposalInput.enablement is a full-row replacement (see
      // ContextVariableEnablementWrite), so a proposal that restates only the fields it means to
      // change has to be merged against the stored row here, field by field, before it reaches
      // that write - otherwise every omitted field (staleness/timeout tuning, a deliberate
      // `enabled: false`) would silently reset. An absent key means "keep the stored value"; an
      // explicit `null` means "clear it" - `"key" in rawEnablement` is the presence test (Zod
      // does not materialize an absent `.optional()` key as `undefined`, verified separately),
      // so `??` alone can't tell those two cases apart.
      const mergedSource = rawEnablement.source;
      // Resolver-only fields (resolverSkillId/maxAgeSeconds/resolverTimeoutMs) only survive the
      // merge when BOTH the proposed and the stored source are "resolver" - carrying them forward
      // across a source change (e.g. resolver -> pushed) would resurrect exactly the
      // contradictory/inert combination assertEnablementIsWellFormed exists to forbid.
      const carriesResolverFields = mergedSource === "resolver" && existingEnablement?.source === "resolver";
      const mergedResolverSkillId = "resolverSkillId" in rawEnablement
        ? rawEnablement.resolverSkillId ?? null
        : (carriesResolverFields ? existingEnablement!.resolverSkillId : null);
      const mergedMaxAgeSeconds = "maxAgeSeconds" in rawEnablement
        ? rawEnablement.maxAgeSeconds ?? null
        : (carriesResolverFields ? existingEnablement!.maxAgeSeconds : null);
      const mergedResolverTimeoutMs = "resolverTimeoutMs" in rawEnablement
        ? rawEnablement.resolverTimeoutMs ?? null
        : (carriesResolverFields ? existingEnablement!.resolverTimeoutMs : null);
      // `enabled` carries forward regardless of source (it is not resolver-only), and only
      // defaults to `true` when there is no stored enablement at all - this is the headline fix:
      // a deliberately-disabled variable must never come back on just because an unrelated field
      // changed.
      const mergedEnabled = "enabled" in rawEnablement && rawEnablement.enabled !== undefined
        ? rawEnablement.enabled
        : (existingEnablement?.enabled ?? true);

      const mergedEnablement: NormalizedContextVariableEnablement = {
        source: mergedSource,
        resolverSkillId: mergedResolverSkillId,
        maxAgeSeconds: mergedMaxAgeSeconds,
        resolverTimeoutMs: mergedResolverTimeoutMs,
        surfacing: rawEnablement.surfacing,
        enabled: mergedEnabled,
      };
      // Checked on the MERGED object, not the raw payload: a proposal that only names
      // `resolverSkillId` in the resolver-inheritance branch above is legitimately incomplete on
      // its own (it relies on a still-resolver stored source to fill the rest in), so asserting
      // the raw payload here would reject a merge this function is meant to allow. Any way the
      // merge could still produce a contradictory/inert combination is caught here instead.
      assertEnablementIsWellFormed(mergedEnablement);
      if (mergedSource === "resolver" && mergedResolverSkillId) {
        // agent_context_variables.resolver_skill_id carries no foreign key either (same
        // migration 112 gap as agent_id), and SkillBackedContextResolver.resolve silently
        // returns null for an id it cannot find, that belongs to another agent, or that is
        // disabled - so a hallucinated or cross-workspace skill id, or one an operator has
        // simply turned off, would persist as an enablement that never resolves, with no error
        // anywhere. Resolving it through this agent's own enabled skills here mirrors the
        // agent-id resolution above. Checked against the EFFECTIVE (merged) id, not the raw
        // payload's, since that is the id that actually gets persisted below - including when a
        // proposal omits resolverSkillId and inherits one whose skill has since been deleted or
        // disabled, which must be refused here rather than silently persisted.
        const agentSkills = await deps.agentSkillsService.list(workspaceId, targetRef.agentId);
        const resolverSkill = agentSkills.find((skill) => skill.id === mergedResolverSkillId);
        if (!resolverSkill) {
          throw badRequest(`resolverSkillId "${mergedResolverSkillId}" does not name a skill on this agent`);
        }
        if (!resolverSkill.enabled) {
          throw badRequest(`resolverSkillId "${mergedResolverSkillId}" names a skill that is disabled on this agent`);
        }
      }
      enablement = mergedEnablement;
    }

    // Scoped to what this proposal actually writes (Apply already does the same - see the
    // comment on encodeContextVariableVersionToken), computed from the exact reads above rather
    // than a follow-up readVersionToken call, so a concurrent edit landing between two separate
    // reads can't pair an expansion built from the first (stale) read with a token from the
    // second, fresher one. For a create, see the comment on contextVariableCreateToken for why
    // this isn't the agent's updatedAt either.
    const includesDefinition = definition !== null;
    const includesEnablement = enablement !== null;
    const proposalVersionToken = encodeContextVariableVersionToken(
      includesDefinition ? (existing ? existing.updatedAt : contextVariableCreateToken(await findBlockingVariable(workspaceId, definition!.name))) : null,
      includesEnablement ? (existingEnablement?.updatedAt ?? null) : null,
    );

    return {
      existing,
      includesDefinition,
      includesEnablement,
      versionToken: proposalVersionToken,
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
    async readVersionToken(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = contextVariableTargetRefSchema.parse(rawTargetRef);
      if (!targetRef.variableId) {
        // A create names no row of its own to read a version from; see the comment on
        // contextVariableCreateToken for what determines staleness instead. The agent is still
        // resolved for its own sake (an unresolvable id must fail here, not only once Apply's
        // write is attempted). A create's enablement half is always null - see resolveProposal's
        // token computation for why.
        await deps.agentService.get(workspaceId, targetRef.agentId);
        const payload = contextVariableStoredPayloadSchema.parse(rawPayload);
        if (!payload.definition) throw new Error("A new context variable proposal has no definition to check for a conflict against");
        const blocking = await findBlockingVariable(workspaceId, payload.definition.name);
        return encodeContextVariableVersionToken(contextVariableCreateToken(blocking), null);
      }
      const parts = await readCurrentVersionParts(workspaceId, { agentId: targetRef.agentId, variableId: targetRef.variableId });
      // Called with only a targetRef (see getProposal), never the proposal's own payload, so the
      // targetRef itself is what has to say which half of the composite token this particular
      // proposal cares about - see the comment on contextVariableTargetRefSchema and on
      // encodeContextVariableVersionToken for why an absent flag means "both" rather than
      // "neither".
      return encodeContextVariableVersionToken(
        targetRef.includesDefinition === false ? null : parts.variableUpdatedAt,
        targetRef.includesEnablement === false ? null : parts.enablementUpdatedAt,
      );
    },
    async preview(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = contextVariableTargetRefSchema.parse(rawTargetRef);
      const payload = contextVariableStoredPayloadSchema.parse(rawPayload);
      const existing = targetRef.variableId ? await deps.contextVariableRepository.get(workspaceId, targetRef.variableId) : null;
      const existingEnablement = await findEnablement(workspaceId, targetRef.agentId, targetRef.variableId);
      const currentDefinition = existing ? projectDefinitionForPreview(existing) : null;
      const currentEnablement = existingEnablement ? projectEnablementForPreview(existingEnablement) : null;
      return {
        targetLabel: payload.name,
        current: { definition: currentDefinition, enablement: currentEnablement },
        // `payload.definition`/`payload.enablement` is `null` when this proposal does not touch
        // that half, not "clear it" - falling back to the projected current value here (rather
        // than showing the stored proposal payload's literal `null`) keeps that half identical on
        // both sides of the diff, so buildCopilotProposalDiff renders nothing for it instead of
        // recursing through every field of `current` as a removal.
        proposed: { definition: payload.definition ?? currentDefinition, enablement: payload.enablement ?? currentEnablement },
      };
    },
    async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
      const targetRef = contextVariableTargetRefSchema.parse(rawTargetRef);
      const payload = contextVariableStoredPayloadSchema.parse(rawPayload);
      try {
        // agent_context_variables.agent_id carries no foreign key; resolved unconditionally and
        // before any write, matching the requireAgent check contextVariableRoutes.ts runs on
        // every write (see readCurrentVersionParts's comment). Not used to gate on updatedAt: a
        // create never touches the agent row, so comparing timestamps here could only ever
        // produce a false "stale" from an unrelated agent edit - never real protection against
        // replaying an apply that already succeeded. That protection comes from applyProposal's
        // own name-uniqueness violation below, translated into a real conflict.
        await deps.agentService.get(workspaceId, targetRef.agentId);
        const decoded = decodeContextVariableVersionToken(token);

        // Every version check is enforced inside applyProposal's own transaction (each write
        // gated by its own predicate, and only for the row its own input actually supplies), not
        // by a read-then-compare here: a pre-read leaves a window where a concurrent edit lands
        // between the check and the write.
        const result = await deps.contextVariableRepository.applyProposal({
          workspaceId,
          agentId: targetRef.agentId,
          variableId: targetRef.variableId,
          definition: payload.definition,
          expectedVariableUpdatedAt: targetRef.variableId ? decoded.variableUpdatedAt : null,
          enablement: payload.enablement,
          expectedEnablementUpdatedAt: decoded.enablementUpdatedAt,
        });
        return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, variableId: result.variableId } };
      } catch (error) {
        if (isStale(error)) return { outcome: "stale" as const };
        return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Context variable apply failed" };
      }
    },
    async validatePayload(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = contextVariableTargetRefSchema.parse(rawTargetRef);
      const { normalized, includesDefinition, includesEnablement, versionToken: proposalVersionToken } = await resolveProposal(workspaceId, targetRef, rawPayload);
      return {
        targetRef: { ...targetRef, includesDefinition, includesEnablement },
        payload: normalized,
        versionToken: proposalVersionToken,
      };
    },
  };
};
