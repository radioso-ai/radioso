import { z } from "zod";

import {
  AuthoredDirectiveService,
  DirectiveAuthorService,
  AgentService,
  AgentRevisionService,
  agentInputFieldSchemas,
  mergeAgentSurfaceSettings,
  validateAgentInput,
  DEFAULT_AGENT_LOCALE_FALLBACK,
  DEFAULT_CONTACT_REQUEST_DELIVERY,
  hasConfiguredContactDestination,
  readNotifyContactDelivery,
  type AgentInput,
  type AuthoredDirective,
  type AuthoredDirectiveInput,
  directiveAuthorStructuredFieldsSchema,
} from "../agents/public.js";
import { exactContentItemSchema, validateExactContentItem } from "../../shared/domain/exactContent.js";
import {
  applyRoutineFieldPatch,
  describeRoutineFieldPatch,
  resolveRoutineFieldPatch,
  projectRoutineForReview,
  routineDefinitionDraftInputSchema,
  routineDefinitionDraftUpdateInputSchema,
  routineFieldPatchSchema,
  type RoutineDefinitionService,
  type RoutineDraftAssistService,
  type RoutineDefinition,
  type RoutineDefinitionDraftInput,
  type RoutineValidationDiagnostic,
} from "../routines/public.js";
import {
  AgentSkillsService,
  mergeSkillConfig,
  type AgentRetrievalAuthoringPort,
  type AgentSkillInvocationMode,
  type AgentSkillView,
} from "../agentSkills/public.js";
import { skillCapabilityIds, type SkillCapabilityDescriptor, type SkillCapabilityId, type SkillCapabilityRegistry } from "../skills/public.js";
import {
  MAX_COPILOT_PROPOSAL_SUMMARY,
  type CopilotAgentGreetingProposalAdapter,
  type CopilotAgentSettingProposalAdapter,
  type CopilotAgentSkillProposalAdapter,
  type CopilotContextVariableProposalAdapter,
  type CopilotDirectiveProposalAdapter,
  type CopilotRoutineProposalAdapter,
} from "./contracts.js";
import type { ContextVariable, AgentContextVariableEnablement } from "../context-variables/public.js";
import type { ContextVariableService } from "../context-variables/public.js";
import { isOwnerRefusal, isStale, versionDate, versionToken } from "./proposalVersioning.js";
import { badRequest, conflict, notFound } from "../../shared/domain/errors.js";

/** Composition-only atomic boundary for an existing agent-skill update and its MCP receipt. */
export interface AgentSkillMcpApplyPort {
  apply(input: {
    readonly workspaceId: string;
    readonly agentId: string;
    readonly skillId: string;
    readonly expectedUpdatedAt: Date;
    readonly target: { readonly kind: string; readonly id: string | null };
    readonly config: Record<string, unknown>;
    readonly invocationMode: AgentSkillInvocationMode;
    readonly enabled: boolean;
    readonly proposalId: string;
    readonly executionInvocationId: string;
    readonly operatorUserId: string;
    readonly claimedAt: Date;
  }): Promise<{ readonly appliedRef: { readonly agentId: string; readonly skillId: string } }>;
}

const directiveTargetRefSchema = z.object({ agentId: z.string().uuid(), directiveId: z.string().uuid().nullable() }).strict();
const directiveCopilotDraftInputSchema = z.object({
  intent: z.string().trim().min(1).max(20_000).optional(),
  ...directiveAuthorStructuredFieldsSchema.shape,
}).strict();
const settingTargetRefSchema = z.object({ agentId: z.string().uuid(), settingKey: z.string().min(1).max(200) }).strict();
/**
 * An agent setting is addressed by one key, but `surfaceSettings` is a whole nested object holding
 * the anonymous-chat and embed surfaces - their enablement, their allowed origins, and their
 * tokens. Reading it back would put a channel token in a card preview that only needs
 * `workspace.agents.read`; applying it would change who can reach the agent, under agent
 * management, with no reach signal on the card and none of the channel audit events the settings
 * service records. Those fields are proposed by name through propose_workspace_setting.
 *
 * Refused on every entry point rather than on the draft alone: a row drafted before this boundary
 * existed, or by an older process mid-deploy, reaches preview and apply without passing validate.
 */
const settingTargetRef = (rawTargetRef: unknown) => {
  const targetRef = settingTargetRefSchema.parse(rawTargetRef);
  if (targetRef.settingKey === "surfaceSettings") {
    throw badRequest("Public channel and embed settings are proposed with propose_workspace_setting, which names each field and states on the card when a change alters who can reach the agent");
  }
  return targetRef;
};
const routineTargetRefSchema = z.object({ agentId: z.string().uuid(), routineId: z.string().uuid().nullable() }).strict();
// The card summary is rebuilt from `payload.rationale` after a reload, which is why every routine
// payload carries the drafted summary under that name rather than only Ray's own words.
const routineEditPayloadSchema = z.object({
  kind: z.literal("edit"),
  name: z.string(),
  changes: routineFieldPatchSchema,
  rationale: z.string().optional(),
}).strict();
const routineStructuralPayloadSchema = z.object({
  kind: z.literal("structural"),
  draft: routineDefinitionDraftUpdateInputSchema,
  operations: z.array(z.unknown()).min(1),
}).strict();
const routineCreatePayloadSchema = z.object({
  kind: z.literal("create"),
  draft: routineDefinitionDraftInputSchema,
}).strict();
const routineDeletePayloadSchema = z.object({ kind: z.literal("delete") }).strict();

/**
 * Composition joins the routine owner's optimistic write to the generic reviewed receipt. The
 * routine module receives no Copilot repository; this port is the only cross-aggregate seam.
 */
export interface RoutineMcpApplyPort {
  apply(input: {
    readonly workspaceId: string;
    readonly agentId: string;
    readonly proposalId: string;
    readonly executionInvocationId: string;
    readonly operatorUserId: string;
    readonly claimedAt: Date;
  } & (
    | { readonly operation: "create"; readonly draft: RoutineDefinitionDraftInput }
    | { readonly operation: "update"; readonly routineId: string; readonly draft: RoutineDefinitionDraftInput; readonly expectedUpdatedAt: Date; readonly removedNodeIds: readonly string[]; readonly removedSlotIds: readonly string[] }
    | { readonly operation: "delete"; readonly routineId: string; readonly expectedUpdatedAt: Date; readonly removedNodeIds: readonly string[]; readonly removedSlotIds: readonly string[] }
  )): Promise<{ readonly appliedRef: { readonly agentId: string; readonly routineId: string }; readonly routine?: RoutineDefinition }>;
}
// Payloads written before routine edits existed carry no `kind`; an absent one is a new-routine
// draft. `"lifecycle"` is a retired payload shape (publish/revise/archive/restore, removed with
// the routine lifecycle collapse): nothing writes it any more, but a proposal row saved before
// this deployed still carries it, and neither create's nor edit's schema can parse it - recognize
// it explicitly so preview/apply can degrade it gracefully instead of misreading it as "create"
// and crashing on a schema mismatch.
const routinePayloadKind = (payload: unknown): "edit" | "create" | "delete" | "lifecycle" | "structural" => {
  const kind = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>).kind : undefined;
  if (kind === "edit" || kind === "delete" || kind === "lifecycle" || kind === "structural") return kind;
  if (kind === "create") return kind;
  return "create";
};
const unsupportedLifecycleProposalMessage = "This proposal type is no longer supported. Dismiss it.";
const requiredRoutineId = (targetRef: { routineId: string | null }): string => {
  if (!targetRef.routineId) throw new Error("This routine proposal names no routine");
  return targetRef.routineId;
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

// Proposal shape remains Ray-owned; the context-variable module validates the
// resulting full enablement before drafts and applies can persist it.
const contextVariableValueTypes = ["string", "json"] as const;
const contextVariableTrustTiers = ["unverified", "signed"] as const;
const contextVariableSensitivities = ["normal", "sensitive"] as const;
const contextVariableSurfacings = ["always", "on_reference", "operator_only"] as const;
const contextVariableSources = ["pushed", "browser", "resolver", "request"] as const;
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
  async draft(workspaceId, rawTargetRef, rawInput) {
    const targetRef = directiveTargetRefSchema.parse(rawTargetRef);
    const input = directiveCopilotDraftInputSchema.parse(rawInput);
    const fields = Object.fromEntries(
      ["name", "condition", "action", "priority", "excludes"]
        .filter((field) => Object.hasOwn(input, field))
        .map((field) => [field, input[field as keyof typeof input]]),
    );
    const draft = await deps.directiveAuthorService.draft(workspaceId, targetRef.agentId, {
      ...(input.intent ? {
        coachingText: input.intent,
        turn: { userMessage: input.intent, assistantAnswer: input.intent },
      } : {}),
      ...(targetRef.directiveId ? { directiveId: targetRef.directiveId } : {}),
      fields,
    });
    const directive = directivePayload(draft.directive);
    const summary = describeDirectiveChange(directive, draft.rationale);
    return { payload: { ...directive, rationale: summary }, targetLabel: directive.name, summary };
  },
});

/** Composition adapter: validates proposal values with the existing agent settings normalizer and applies through AgentService. */
export const createAgentSettingCopilotProposalAdapter = (deps: {
  readonly agentService: Pick<AgentService, "get" | "update">;
}): CopilotAgentSettingProposalAdapter => ({
  targetType: "agent_setting",
  async readVersionToken(workspaceId, rawTargetRef) {
    const targetRef = settingTargetRef(rawTargetRef);
    return versionToken((await deps.agentService.get(workspaceId, targetRef.agentId)).updatedAt);
  },
  async preview(workspaceId, rawTargetRef, rawPayload) {
    const targetRef = settingTargetRef(rawTargetRef);
    const payload = settingPayloadSchema.parse(rawPayload);
    const current = await deps.agentService.get(workspaceId, targetRef.agentId).catch(() => null);
    return { targetLabel: targetRef.settingKey, current: current ? settingValue(current, targetRef.settingKey) : null, proposed: payload.value };
  },
  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
    const targetRef = settingTargetRef(rawTargetRef);
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
    const targetRef = settingTargetRef(rawTargetRef);
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

const greetingTargetRefSchema = z.object({ agentId: z.string().uuid() }).strict();
const greetingPayloadSchema = z.object({
  exactWordsEnabled: z.boolean(),
  exactContent: exactContentItemSchema.nullable(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
  summary: z.string().min(1).max(MAX_COPILOT_PROPOSAL_SUMMARY).optional(),
}).strict();

/** Encodes/decodes `agent_drafts.generation` as the greeting proposal's version token. Not the
 * `versionToken`/`versionDate` pair above: those anchor to a row's `updated_at`, but the
 * greeting has no row of its own, and anchoring to the *agent's* `updatedAt` is what let a
 * dashboard greeting edit go undetected (that write only ever bumps `agent_drafts`). */
const draftGenerationToken = (generation: number): string => `draft-generation:${generation}`;
const parseDraftGenerationToken = (token: string): number | null => {
  const match = /^draft-generation:(\d+)$/.exec(token);
  return match ? Number(match[1]) : null;
};

/**
 * Composition adapter: writes exact greeting content through `AgentService.updateDraftGreeting`
 * only — never the live `agents` row `agent_setting` writes through (see
 * `CopilotAgentGreetingProposalAdapter`'s doc comment for why that adapter is not reused here).
 * Staleness is checked against `agent_drafts.generation` — the same fence every other draft
 * writer (a directive create, a routine field patch, `AgentRevisionService.createCandidate`)
 * already serializes on — because that is the column the greeting write actually bumps. The
 * comparison itself happens inside `AgentRepository#updateDraftGreeting`'s own
 * `withAgentDraftMutation` transaction, not here: reading the generation and writing the
 * greeting as two separate steps would reopen the same race this fixes.
 */
export const createAgentGreetingCopilotProposalAdapter = (deps: {
  readonly agentService: Pick<AgentService, "get" | "updateDraftGreeting">;
  readonly agentRevisions: Pick<AgentRevisionService, "state">;
}): CopilotAgentGreetingProposalAdapter => ({
  targetType: "agent_greeting",
  async readVersionToken(workspaceId, rawTargetRef) {
    const targetRef = greetingTargetRefSchema.parse(rawTargetRef);
    const state = await deps.agentRevisions.state(workspaceId, targetRef.agentId);
    return draftGenerationToken(state.draft.generation);
  },
  async preview(_workspaceId, rawTargetRef, rawPayload) {
    greetingTargetRefSchema.parse(rawTargetRef);
    const payload = greetingPayloadSchema.parse(rawPayload);
    const { rationale: _rationale, summary: _summary, ...proposed } = payload;
    // No cheap read of the current draft's greeting exists (AgentService exposes only the live
    // agent, which never carries it — see the class doc comment above); stating "current: null" is
    // honest rather than a stand-in for a diff this adapter cannot produce without new plumbing.
    return { targetLabel: "Greeting", current: null, proposed };
  },
  async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
    const targetRef = greetingTargetRefSchema.parse(rawTargetRef);
    const payload = greetingPayloadSchema.parse(rawPayload);
    const expectedDraftGeneration = parseDraftGenerationToken(token);
    if (expectedDraftGeneration === null) return { outcome: "stale" as const };
    const agent = await deps.agentService.get(workspaceId, targetRef.agentId).catch(() => null);
    if (!agent) return { outcome: "failed" as const, reason: "Agent not found" };
    try {
      await deps.agentService.updateDraftGreeting(workspaceId, targetRef.agentId, {
        exactWordsEnabled: payload.exactWordsEnabled,
        exactContent: payload.exactContent,
      }, { expectedDraftGeneration });
      return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId } };
    } catch (error) {
      if (isStale(error)) return { outcome: "stale" as const };
      return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Greeting draft save failed" };
    }
  },
  async validatePayload(workspaceId, rawTargetRef, rawPayload) {
    const targetRef = greetingTargetRefSchema.parse(rawTargetRef);
    const payload = greetingPayloadSchema.parse(rawPayload);
    const agent = await deps.agentService.get(workspaceId, targetRef.agentId);
    // Mirrors `AgentService.updateDraftGreeting` exactly (same locale fallback, same empty
    // reference set — bootstrap supplies no context variables and the greeting has no routine
    // slots) so a proposal can never validate content the draft route itself would refuse.
    const validation = payload.exactContent
      ? validateExactContentItem(payload.exactContent, {
          agentDefaultLocale: agent.assistantDefaultLocale ?? DEFAULT_AGENT_LOCALE_FALLBACK,
          availableReferenceKeys: new Set(),
        })
      : ({ ok: true } as const);
    if (payload.exactWordsEnabled && !validation.ok) {
      throw badRequest("Exact greeting content is invalid", { issues: validation.issues });
    }
    // Read right before returning, for the same reason `agent_setting`'s validatePayload reads
    // its token from this same call rather than a follow-up `readVersionToken`.
    const state = await deps.agentRevisions.state(workspaceId, targetRef.agentId);
    return { targetRef, payload, versionToken: draftGenerationToken(state.draft.generation) };
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
  readonly atomicMcpApply?: AgentSkillMcpApplyPort;
  readonly retrievalAuthoring?: Pick<AgentRetrievalAuthoringPort, "validatePrepared">;
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
      { name, capability: descriptor.id, target, config, invocationMode, enabled },
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
      : await createSkillVersionToken(workspaceId, targetRef.agentId, name, invocationMode);

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
    async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token, context) {
      const targetRef = skillTargetRefSchema.parse(rawTargetRef);
      const payload = skillConfigStoredPayloadSchema.parse(rawPayload);
      // True exactly on the branch that writes the skill and settles this receipt inside one DB
      // transaction (dryRunValidate/validatePrepared runs first on that same branch, before any
      // write). It is the only write path here proven atomic enough for a refusal on it to prove
      // nothing was written; the plain update/create fallbacks are not.
      const mcpAtomicApply = Boolean(targetRef.skillId && context?.surface === "mcp" && context.proposalId && context.executionInvocationId && context.operatorUserId && context.applyClaimedAt && deps.atomicMcpApply);
      try {
        if (targetRef.skillId) {
          const config = payload.capability === "retrieve" && payload.invocationMode === "default_answer" && deps.retrievalAuthoring
            ? await deps.retrievalAuthoring.validatePrepared({ workspaceId, agentId: targetRef.agentId, skillId: targetRef.skillId, config: payload.config, skill: { ...payload, capability: "retrieve", invocationMode: "default_answer" } })
            : await deps.agentSkillsService.dryRunValidate(workspaceId, targetRef.agentId, { name: payload.name, capability: payload.capability as SkillCapabilityId, target: payload.target, config: payload.config, invocationMode: payload.invocationMode, enabled: payload.enabled }, targetRef.skillId);
          if (context?.surface === "mcp" && context.proposalId && context.executionInvocationId && context.operatorUserId && context.applyClaimedAt && deps.atomicMcpApply) {
            const settled = await deps.atomicMcpApply.apply({
              workspaceId,
              agentId: targetRef.agentId,
              skillId: targetRef.skillId,
              expectedUpdatedAt: versionDate(token),
              target: payload.target,
              config,
              invocationMode: payload.invocationMode as AgentSkillInvocationMode,
              enabled: payload.enabled,
              proposalId: context.proposalId,
              executionInvocationId: context.executionInvocationId,
              operatorUserId: context.operatorUserId,
              claimedAt: context.applyClaimedAt,
            });
            return { outcome: "applied" as const, appliedRef: settled.appliedRef };
          }
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
        if (context?.surface === "mcp" && context.executionInvocationId) {
          // A non-stale owner refusal on the atomic branch proves nothing was written (see
          // mcpAtomicApply above). Anything else - the plain update/create fallback, or any
          // infrastructure fault - keeps its uncertainty: the atomic write may have committed with
          // its receipt immediately before a transport failure, so only the reviewed executor's
          // reconcile path may resolve it.
          if (mcpAtomicApply && isOwnerRefusal(error)) return { outcome: "failed" as const, reason: error.message };
          throw error;
        }
        return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Skill apply failed" };
      }
    },
    async validatePayload(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = skillTargetRefSchema.parse(rawTargetRef);
      const { normalized, versionToken: proposalVersionToken } = await resolveProposal(workspaceId, targetRef, rawPayload);
      return { targetRef, payload: normalized, versionToken: proposalVersionToken };
    },
    async reconcileMcpInterruptedApply(input) {
      const targetRef = skillTargetRefSchema.parse(input.targetRef);
      const payload = skillConfigStoredPayloadSchema.parse(input.payload);
      // The retrieval MCP path uses `atomicMcpApply`, which writes the skill and settles this
      // proposal receipt in one transaction. A reclaimed pending receipt proves that transaction
      // did not commit, so the generic executor may safely retry the exact operation.
      if (targetRef.skillId && payload.capability === "retrieve" && payload.invocationMode === "default_answer" && deps.atomicMcpApply) {
        return { outcome: "not_applied" as const };
      }
      return { outcome: "unknown" as const, reason: "This skill operation cannot prove whether an interrupted apply reached the agent draft." };
    },
  };
};

/**
 * Composition adapter for routines: translates Copilot proposals into the routine module's
 * authoring operations. It owns proposal-specific preview and stale-card behavior; applying an
 * edit writes into the agent's private draft, and the agent's own Review & Publish remains the
 * only thing that changes what customers see.
 */
export const createRoutineCopilotProposalAdapter = (deps: {
  readonly agentService: Pick<AgentService, "get">;
  readonly routineDraftAssistService: Pick<RoutineDraftAssistService, "draft">;
  readonly routineDefinitionService: Pick<RoutineDefinitionService, "completeExternalDraftMutation" | "createDraft" | "deleteDraft" | "findCreateConflict" | "get" | "list" | "updateDraft" | "validate">;
  readonly logger?: { warn(fields: Record<string, unknown>, message: string): void };
  readonly routineMcpApply?: RoutineMcpApplyPort;
  readonly scopedReferences?: {
    assertNoScopedReferences(input: { readonly workspaceId: string; readonly agentId: string; readonly routineId: string; readonly removedNodeIds: readonly string[]; readonly removedSlotIds: readonly string[] }): Promise<void>;
  };
}): CopilotRoutineProposalAdapter => {
  const routineFor = async (workspaceId: string, targetRef: { agentId: string; routineId: string | null }) =>
    deps.routineDefinitionService.get(workspaceId, targetRef.agentId, requiredRoutineId(targetRef));

  /**
   * A create proposal's version token: whichever routine already occupies the (name, version 1)
   * identity a fresh createDraft would take - the routine_definition_agent_id_name_version_key
   * constraint createDraft's own catch translates into a conflict - or null when none does.
   * `findCreateConflict` checks this directly rather than scanning `list()` (one canonical row
   * per lineage): a pre-cutover lineage can still carry a retired, non-canonical row at
   * `(name, version 1)` while its canonical row has since been renamed to something else, which
   * `list()` would never surface under the old name. Read fresh both when the proposal is
   * drafted (to seed its stored token) and again at GET time (to recompute it), so the two only
   * diverge when that specific conflict changes - never from an unrelated agent edit. The agent
   * is still resolved for its own sake (an unresolvable id must fail here, not only once Apply's
   * write is attempted), just no longer used for the token.
   */
  const createRoutineVersionToken = async (workspaceId: string, agentId: string, name: string): Promise<string> => {
    await deps.agentService.get(workspaceId, agentId);
    const blocking = await deps.routineDefinitionService.findCreateConflict(workspaceId, agentId, name);
    return blocking ? `blocked:${blocking.id}:${versionToken(blocking.updatedAt)}` : "open";
  };
  const revalidateScopedReferences = async (workspaceId: string, agentId: string, routine: RoutineDefinition, draft?: z.infer<typeof routineStructuralPayloadSchema>["draft"]): Promise<void> => {
    if (!deps.scopedReferences) throw new Error("Routine scoped-reference validation is unavailable");
    const survivingNodeIds = new Set(draft ? [...draft.steps, ...draft.terminals].map((node) => node.stableStepId) : []);
    const survivingSlotIds = new Set(draft?.slots?.map((slot) => slot.stableSlotId) ?? []);
    await deps.scopedReferences.assertNoScopedReferences({
      workspaceId,
      agentId,
      routineId: routine.id,
      removedNodeIds: [...routine.steps, ...routine.terminals].map((node) => node.stableStepId).filter((id) => !survivingNodeIds.has(id)),
      removedSlotIds: (routine.slots ?? []).map((slot) => slot.stableSlotId).filter((id) => !survivingSlotIds.has(id)),
    });
  };

  return {
    targetType: "routine",
    async readVersionToken(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = routineTargetRefSchema.parse(rawTargetRef);
      // See the comment on createRoutineVersionToken for why a new routine's token is not the
      // agent's updatedAt; an existing one still guards itself.
      if (!targetRef.routineId) return createRoutineVersionToken(workspaceId, targetRef.agentId, routineCreateDraft(rawPayload).name);
      if (routinePayloadKind(rawPayload) === "delete") {
        return routineFor(workspaceId, targetRef).then((routine) => versionToken(routine.updatedAt)).catch(() => "deleted");
      }
      const routine = await routineFor(workspaceId, targetRef);
      return versionToken(routine.updatedAt);
    },
    async preview(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = routineTargetRefSchema.parse(rawTargetRef);
      const kind = routinePayloadKind(rawPayload);
      if (kind === "lifecycle") {
        const routine = targetRef.routineId ? await routineFor(workspaceId, targetRef).catch(() => null) : null;
        return {
          targetLabel: routine?.name ?? "This routine",
          current: null,
          proposed: { editNoLongerApplies: unsupportedLifecycleProposalMessage },
        };
      }
      if (kind === "create") {
        const proposed = routineCreateDraft(rawPayload);
        return { targetLabel: proposed.name, current: null, proposed: projectRoutineForReview(proposed) };
      }
      const routine = await routineFor(workspaceId, targetRef).catch(() => null);
      if (kind === "delete") {
        routineDeletePayloadSchema.parse(rawPayload);
        return routine
          ? { targetLabel: routine.name, current: projectRoutineForReview(routine), proposed: { deleted: true } }
          : { targetLabel: "This routine", current: null, proposed: { editNoLongerApplies: "This routine no longer exists." } };
      }
      if (kind === "structural") {
        const payload = routineStructuralPayloadSchema.parse(rawPayload);
        return routine
          ? { targetLabel: routine.name, current: projectRoutineForReview(routine), proposed: payload.draft }
          : { targetLabel: "This routine", current: null, proposed: { editNoLongerApplies: "This routine no longer exists." } };
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
    async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token, context) {
      const targetRef = routineTargetRefSchema.parse(rawTargetRef);
      const kind = routinePayloadKind(rawPayload);
      if (kind === "lifecycle") {
        return { outcome: "failed" as const, reason: unsupportedLifecycleProposalMessage };
      }
      // True only inside an atomic reviewed-MCP branch until routineMcpApply.apply resolves. There, the
      // validation and scoped-reference checks run before the write, and the write settles this
      // receipt in one transaction that a thrown refusal rolls back, so a refusal proves nothing
      // was written. The field-edit path and the plain service writes never set it.
      let refusalWroteNothing = false;
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
          const draft = routineCreateDraft(rawPayload);
          if (context?.surface === "mcp" && context.proposalId && context.executionInvocationId && context.operatorUserId && context.applyClaimedAt && deps.routineMcpApply) {
            refusalWroteNothing = true;
            const validation = await deps.routineDefinitionService.validate(workspaceId, targetRef.agentId, { input: draft });
            if (!validation.ok) return { outcome: "failed" as const, reason: diagnosticSummary(validation.diagnostics) || "Routine validation failed" };
            const settled = await deps.routineMcpApply.apply({ workspaceId, agentId: targetRef.agentId, operation: "create", draft, proposalId: context.proposalId, executionInvocationId: context.executionInvocationId, operatorUserId: context.operatorUserId, claimedAt: context.applyClaimedAt });
            refusalWroteNothing = false;
            if (settled.routine) await deps.routineDefinitionService.completeExternalDraftMutation(workspaceId, targetRef.agentId, settled.routine);
            return { outcome: "applied" as const, appliedRef: settled.appliedRef };
          }
          const result = await deps.routineDefinitionService.createDraft(workspaceId, targetRef.agentId, draft);
          // The card deep-links from appliedRef alone when the proposal detail was
          // never loaded, so the agent id must travel with the routine id.
          return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, routineId: result.routine.id } };
        }
        const routine = await routineFor(workspaceId, targetRef);
        if (versionToken(routine.updatedAt) !== token) return { outcome: "stale" as const };
        if (kind === "delete") {
          routineDeletePayloadSchema.parse(rawPayload);
          if (context?.surface === "mcp" && context.proposalId && context.executionInvocationId && context.operatorUserId && context.applyClaimedAt && deps.routineMcpApply) {
            refusalWroteNothing = true;
            await revalidateScopedReferences(workspaceId, targetRef.agentId, routine);
            const settled = await deps.routineMcpApply.apply({ workspaceId, agentId: targetRef.agentId, operation: "delete", routineId: routine.id, expectedUpdatedAt: routine.updatedAt, removedNodeIds: [...routine.steps, ...routine.terminals].map((node) => node.stableStepId), removedSlotIds: (routine.slots ?? []).map((slot) => slot.stableSlotId), proposalId: context.proposalId, executionInvocationId: context.executionInvocationId, operatorUserId: context.operatorUserId, claimedAt: context.applyClaimedAt });
            refusalWroteNothing = false;
            return { outcome: "applied" as const, appliedRef: settled.appliedRef };
          }
          await deps.routineDefinitionService.deleteDraft(workspaceId, targetRef.agentId, routine.id, { expectedUpdatedAt: routine.updatedAt });
          return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, routineId: routine.id } };
        }
        if (kind === "structural") {
          const payload = routineStructuralPayloadSchema.parse(rawPayload);
          if (context?.surface === "mcp" && context.proposalId && context.executionInvocationId && context.operatorUserId && context.applyClaimedAt && deps.routineMcpApply) {
            refusalWroteNothing = true;
            // Preparation validates the authored transform, but skills, action capability policy,
            // and context variables can move before confirmation. Re-run the owning validator
            // immediately before its fenced write; the CAS then proves this is the same routine.
            const validation = await deps.routineDefinitionService.validate(workspaceId, targetRef.agentId, { input: payload.draft });
            if (!validation.ok) {
              return { outcome: "failed" as const, reason: diagnosticSummary(validation.diagnostics) || "Routine validation failed" };
            }
            await revalidateScopedReferences(workspaceId, targetRef.agentId, routine, payload.draft);
            const settled = await deps.routineMcpApply.apply({
              workspaceId,
              agentId: targetRef.agentId,
              operation: "update",
              routineId: routine.id,
              draft: routineDefinitionDraftInputSchema.parse(payload.draft),
              expectedUpdatedAt: routine.updatedAt,
              removedNodeIds: [...routine.steps, ...routine.terminals].map((node) => node.stableStepId).filter((id) => !new Set([...payload.draft.steps, ...payload.draft.terminals].map((node) => node.stableStepId)).has(id)),
              removedSlotIds: (routine.slots ?? []).map((slot) => slot.stableSlotId).filter((id) => !new Set(payload.draft.slots?.map((slot) => slot.stableSlotId) ?? []).has(id)),
              proposalId: context.proposalId,
              executionInvocationId: context.executionInvocationId,
              operatorUserId: context.operatorUserId,
              claimedAt: context.applyClaimedAt,
            });
            refusalWroteNothing = false;
            if (!settled.routine) return { outcome: "failed" as const, reason: "Routine update did not return its saved draft" };
            await deps.routineDefinitionService.completeExternalDraftMutation(workspaceId, targetRef.agentId, settled.routine);
            return { outcome: "applied" as const, appliedRef: settled.appliedRef };
          }
          await deps.routineDefinitionService.updateDraft(workspaceId, targetRef.agentId, routine.id, payload.draft, { expectedUpdatedAt: routine.updatedAt });
          return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, routineId: routine.id } };
        }
        const payload = routineEditPayloadSchema.parse(rawPayload);
        // The edit lands in the agent's private draft, the same as any other authoring write.
        // Nothing an operator applies here changes what customers see until Review & Publish.
        await deps.routineDefinitionService.updateDraft(
          workspaceId,
          targetRef.agentId,
          routine.id,
          applyRoutineFieldPatch(routine, payload.changes),
          { expectedUpdatedAt: routine.updatedAt },
        );
        return { outcome: "applied" as const, appliedRef: { agentId: targetRef.agentId, routineId: routine.id } };
      } catch (error) {
        if (isStale(error)) return { outcome: "stale" as const };
        if (context?.surface === "mcp" && context.executionInvocationId) {
          if (refusalWroteNothing && isOwnerRefusal(error)) return { outcome: "failed" as const, reason: error.message };
          // Otherwise the owner may have committed just before its response was lost. Let the
          // generic executor retain the receipt as uncertain instead of falsely certifying failure.
          throw error;
        }
        return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Routine change failed" };
      }
    },
    async reconcileMcpInterruptedApply(input) {
      // Reviewed routine create/delete/structural writes and their receipt settlement share one
      // database transaction. Reclaiming a still-pending proposal therefore proves an earlier
      // claimed attempt committed neither side; it is safe to retry the exact operation.
      const kind = routinePayloadKind(input.payload);
      if (kind === "create" || kind === "delete" || kind === "structural") return { outcome: "not_applied" as const };
      return { outcome: "unknown" as const, reason: "This legacy routine proposal cannot prove whether an interrupted apply reached the draft." };
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
      const routine = await routineFor(workspaceId, targetRef);
      const changes = resolveRoutineFieldPatch(routine, routineFieldPatchSchema.parse(rawChanges));
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
  };
};

/**
 * Identifies a diagnostic across an edit. Locations address stable ids, except routine-level ones,
 * which carry the routine's name — so renaming a routine would otherwise look like it introduced
 * every routine-level diagnostic the routine already had, and block the rename.
 */
const diagnosticIdentity = (diagnostic: RoutineValidationDiagnostic): string =>
  `${diagnostic.code}@${diagnostic.location.startsWith("routine:") ? "routine:" : diagnostic.location}`;

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
    coverageCriteria: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional(),
  }).parse(value);
  return draft as AuthoredDirectiveInput;
};

const describeDirectiveChange = (directive: AuthoredDirectiveInput, rationale?: string): string => {
  const details = [
    directive.priority === null || directive.priority === undefined ? null : `Priority ${directive.priority}.`,
    directive.excludes?.length ? `Replaces ${directive.excludes.join(", ")}.` : null,
  ].filter((detail): detail is string => detail !== null);
  return [rationale ?? directive.name, ...details].join(" ");
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
const routineCreateDraft = (value: unknown) => {
  const parsed = routineCreatePayloadSchema.safeParse(value);
  return parsed.success ? parsed.data.draft : routinePayload(value);
};

const settingPatch = (settingKey: string, value: unknown): AgentInput => {
  const schema = agentInputFieldSchemas[settingKey as keyof typeof agentInputFieldSchemas];
  if (!schema) throw badRequest(`Unknown agent setting: ${settingKey}`);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest(`Invalid ${settingKey} setting value`);
  return { [settingKey]: parsed.data };
};
const settingValue = (settings: object, settingKey: string): unknown => Object.hasOwn(settings, settingKey) ? (settings as Record<string, unknown>)[settingKey] : undefined;

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
 *
 * Reachability is read through `readNotifyContactDelivery`/`hasConfiguredContactDestination` -
 * the same reader and gate dispatch and activation use - so this refusal cannot drift from what
 * actually fires.
 */
const assertNotifyDeliveryIsReachable = (capabilityId: string, config: Record<string, unknown>): void => {
  if (capabilityId !== "notify") return;
  const delivery = readNotifyContactDelivery(config) ?? DEFAULT_CONTACT_REQUEST_DELIVERY;
  if (!hasConfiguredContactDestination(delivery)) {
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
  contextVariables: Pick<ContextVariableService, "listByAgent">,
  workspaceId: string,
  agentId: string,
  variableId: string | null,
): Promise<AgentContextVariableEnablement | null> => {
  if (!variableId) return null;
  const enablements = await contextVariables.listByAgent(workspaceId, agentId);
  return enablements.find((enablement) => enablement.variableId === variableId) ?? null;
};

/**
 * Composition adapter: a context variable's workspace-scoped definition and one agent's
 * enablement of it are two separate resources this adapter can create or update from a single
 * proposal. Ray supplies concrete field values it already read (from the context_variables
 * reader), never a draft from prose, so validation happens entirely in `validatePayload` — the
 * same shape as propose_skill_config.
 */
export const createContextVariableCopilotProposalAdapter = (deps: {
  readonly contextVariables: Pick<ContextVariableService, "get" | "listByAgent" | "listByWorkspace" | "requireAgent" | "assertEnablementReferences" | "applyProposal">;
}): CopilotContextVariableProposalAdapter => {
  const findEnablement = (workspaceId: string, agentId: string, variableId: string | null) =>
    findAgentContextVariableEnablement(deps.contextVariables, workspaceId, agentId, variableId);

  const findBlockingVariable = async (workspaceId: string, name: string): Promise<ContextVariable | null> => {
    const variables = await deps.contextVariables.listByWorkspace(workspaceId);
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
    // The module service resolves the agent through its workspace before reading the
    // version parts, preserving tenant ownership independently of the database FK.
    await deps.contextVariables.requireAgent(workspaceId, targetRef.agentId);
    const variable = await deps.contextVariables.get(workspaceId, targetRef.variableId);
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
    await deps.contextVariables.requireAgent(workspaceId, targetRef.agentId);
    const existing = targetRef.variableId ? await deps.contextVariables.get(workspaceId, targetRef.variableId) : null;
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
        : (carriesResolverFields ? existingEnablement.resolverSkillId : null);
      const mergedMaxAgeSeconds = "maxAgeSeconds" in rawEnablement
        ? rawEnablement.maxAgeSeconds ?? null
        : (carriesResolverFields ? existingEnablement.maxAgeSeconds : null);
      const mergedResolverTimeoutMs = "resolverTimeoutMs" in rawEnablement
        ? rawEnablement.resolverTimeoutMs ?? null
        : (carriesResolverFields ? existingEnablement.resolverTimeoutMs : null);
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
      // merge could still produce a contradictory/inert combination is caught by the
      // context-variable service here instead.
      await deps.contextVariables.assertEnablementReferences(
        workspaceId,
        targetRef.agentId,
        targetRef.variableId,
        mergedEnablement,
      );
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
        await deps.contextVariables.requireAgent(workspaceId, targetRef.agentId);
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
      const existing = targetRef.variableId ? await deps.contextVariables.get(workspaceId, targetRef.variableId) : null;
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
        // The context-variable service resolves the agent again inside applyProposal. That check
        // is not used to gate on updatedAt: a
        // create never touches the agent row, so comparing timestamps here could only ever
        // produce a false "stale" from an unrelated agent edit - never real protection against
        // replaying an apply that already succeeded. That protection comes from applyProposal's
        // own name-uniqueness violation below, translated into a real conflict.
        await deps.contextVariables.requireAgent(workspaceId, targetRef.agentId);
        const decoded = decodeContextVariableVersionToken(token);

        // Every version check is enforced inside applyProposal's own transaction (each write
        // gated by its own predicate, and only for the row its own input actually supplies), not
        // by a read-then-compare here: a pre-read leaves a window where a concurrent edit lands
        // between the check and the write.
        const result = await deps.contextVariables.applyProposal({
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
