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
import type {
  CopilotAgentSettingProposalAdapter,
  CopilotDirectiveProposalAdapter,
  CopilotRoutineProposalAdapter,
} from "../../modules/operatorCopilot/public.js";
import { AppError } from "../../shared/domain/errors.js";

const directiveTargetRefSchema = z.object({ agentId: z.string().uuid(), directiveId: z.string().uuid().nullable() }).strict();
const settingTargetRefSchema = z.object({ agentId: z.string().uuid(), settingKey: z.string().min(1).max(200) }).strict();
const routineTargetRefSchema = z.object({ agentId: z.string().uuid(), routineId: z.null() }).strict();
const settingPayloadSchema = z.object({ value: z.unknown(), rationale: z.string().min(1).max(1_000).optional() }).strict();

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
      return { outcome: "applied" as const, appliedRef: { routineId: result.routine.id } };
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
    return { payload: result.draft, targetLabel: result.draft.name, summary };
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

const routinePayload = (value: unknown) =>
  routineDefinitionDraftInputSchema.parse(value);

const settingPatch = (settingKey: string, value: unknown): AgentInput => ({ [settingKey]: value }) as AgentInput;
const settingValue = (settings: object, settingKey: string): unknown => Object.hasOwn(settings, settingKey) ? (settings as Record<string, unknown>)[settingKey] : undefined;
const versionToken = (updatedAt: Date): string => updatedAt.toISOString();
const versionDate = (token: string): Date => new Date(token);
const isStale = (error: unknown): boolean => error instanceof AppError && (error.code === "conflict" || error.code === "not_found");
