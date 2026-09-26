import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { AgentRepositoryPort } from "../../../db/repositories/agentRepository.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import { AppError, badRequest, notFound } from "../../../shared/domain/errors.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { authoredDirectiveInputSchema, authoredDirectiveSurfaceValues, validateDirectiveReplacementNames } from "../authoredDirectives.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { traceOperation } from "../../../shared/observability/tracing/operations.js";
import type { TelemetryService } from "../../../shared/observability/telemetry/telemetryService.js";
import type { AgentRecord } from "../domain.js";

export interface DirectiveAuthorTextGenerationPort {
  complete(input: {
    operation: ModelCallUsageContext;
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

type DirectiveAuthorAgentContext = Pick<
  AgentRecord,
  "id" | "name" | "customInstruction" | "greetingInstruction" | "updatedAt"
>;

const directiveAuthorTurnSchema = z.object({
  userMessage: z.string().trim().min(1).max(20_000),
  assistantAnswer: z.string().trim().min(1).max(40_000),
  activeRoutineId: z.string().trim().min(1).max(200).optional(),
  activeStepId: z.string().trim().min(1).max(200).optional(),
}).strict();

const MAX_DIRECTIVE_REPLACEMENTS = 100;

const directiveAuthorStructuredFieldsSchema = authoredDirectiveInputSchema.pick({
  name: true,
  condition: true,
  action: true,
  priority: true,
  excludes: true,
}).extend({
  excludes: z.array(z.string().trim().min(1).max(200)).max(MAX_DIRECTIVE_REPLACEMENTS).optional(),
}).partial().strict();

/** Flat operator-facing fields; projection into the authoring command stays in this owner. */
export const directiveAuthorProposalInputSchema = z.object({
  intent: z.string().trim().min(1).max(20_000).optional(),
  ...directiveAuthorStructuredFieldsSchema.shape,
});

export const directiveAuthorDraftInputSchema = z.object({
  coachingText: z.string().trim().min(1).max(20_000).optional(),
  turn: directiveAuthorTurnSchema.optional(),
  directiveId: z.string().uuid().optional(),
  fields: directiveAuthorStructuredFieldsSchema.optional(),
}).strict();

const directiveAuthorDraftSchema = z.object({
  directive: z.object({
    name: z.string().trim().min(1).max(200),
    condition: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("always") }).strict(),
      z.object({
        kind: z.literal("contextual"),
        description: z.string().trim().min(1).max(2_000),
      }).strict(),
    ]),
    action: z.string().trim().min(1).max(4_000),
    priority: z.number().int().min(0).max(100).nullable().optional(),
    excludes: z.array(z.string().trim().min(1).max(200)).optional(),
    tags: z.array(z.string().trim().min(1).max(200)).optional(),
    surfaces: z.array(z.enum(authoredDirectiveSurfaceValues)).optional(),
  }).strict(),
  diagnosis: z.enum(["directive_recommended", "knowledge_recommended_deferred"]),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict();

type DirectiveAuthorDraftInput = z.infer<typeof directiveAuthorDraftInputSchema>;
type DirectiveAuthorDraftResult = z.infer<typeof directiveAuthorDraftSchema>;

interface DirectiveAuthorServiceOptions {
  repository: Pick<AgentRepositoryPort, "findByIdAndWorkspaceId" | "listDirectives">;
  textGenerationClient: DirectiveAuthorTextGenerationPort;
  logger: Pick<AppLogger, "info" | "warn">;
  telemetryService?: Pick<TelemetryService, "emit">;
  buildStepScopeTag: (routineId: string, stepId: string) => string;
}

const PROMPT_PATH = "coach/draft-directive.md";

/**
 * A directive create's optimistic fence: whether the agent still exists, never the agent row's own
 * `updatedAt`. Drafting several proposals together (a directive plus unrelated agent-setting
 * changes) must not invalidate each other's creates when one applies first, so a create is fenced
 * only on its agent, not on unrelated agent-row mutations. This exact string is persisted in
 * pending copilot proposal version tokens, so it must not change.
 */
export const DIRECTIVE_CREATE_FENCE = "agent-exists";

const cleanJsonCompletion = (raw: string): string =>
  raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

const renderTemplate = (template: string, variables: Record<string, string>): string =>
  template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => {
    if (!(key in variables)) {
      throw new Error(`Missing prompt variable "${key}" for template ${PROMPT_PATH}`);
    }
    return variables[key] ?? "";
  });

const parseDraft = (raw: string): DirectiveAuthorDraftResult | null => {
  try {
    const parsed = JSON.parse(cleanJsonCompletion(raw));
    const result = directiveAuthorDraftSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

const serializePromptData = (value: unknown): string => JSON.stringify(value, null, 2);

const defaultTags = (
  draft: DirectiveAuthorDraftResult,
  input: DirectiveAuthorDraftInput,
  buildStepScopeTag: DirectiveAuthorServiceOptions["buildStepScopeTag"],
): string[] => {
  const tags = draft.directive.tags;
  if (tags && tags.length > 0) {
    return [...new Set(tags)];
  }
  if (tags) {
    return [];
  }
  const { activeRoutineId, activeStepId } = input.turn ?? {};
  return activeRoutineId && activeStepId ? [buildStepScopeTag(activeRoutineId, activeStepId)] : [];
};

const invalidDraftError = () =>
  new AppError(
    422,
    "invalid_directive_draft",
    "The directive draft could not be generated as valid JSON. Try again or revise the coaching text.",
  );

const hasRequiredDirectiveFields = (
  fields: z.infer<typeof directiveAuthorStructuredFieldsSchema>,
): fields is z.infer<typeof directiveAuthorStructuredFieldsSchema> & {
  name: string;
  condition: NonNullable<z.infer<typeof directiveAuthorStructuredFieldsSchema>["condition"]>;
  action: string;
} => fields.name !== undefined && fields.condition !== undefined && fields.action !== undefined;

/**
 * The copilot descriptor adds transport-only fields such as agentId and evidenceIds. This owner
 * projection deliberately strips those fields in one place before authoring starts.
 */
export const projectDirectiveAuthorProposalInput = (raw: unknown): Omit<DirectiveAuthorDraftInput, "directiveId"> => {
  const { intent, ...fields } = directiveAuthorProposalInputSchema.parse(raw);
  return {
    ...(intent ? { coachingText: intent, turn: { userMessage: intent, assistantAnswer: intent } } : {}),
    fields,
  };
};

export class DirectiveAuthorService {
  constructor(private readonly options: DirectiveAuthorServiceOptions) {}

  async draft(
    workspaceId: string,
    agentId: string,
    input: DirectiveAuthorDraftInput,
  ): Promise<DirectiveAuthorDraftResult> {
    return (await this.draftWithFence(workspaceId, agentId, input)).draft;
  }

  /**
   * Produces a proposal draft and its optimistic fence from the same owner snapshots. An edit's
   * full payload is expanded from the directive row whose updatedAt supplies the fence; a create
   * carries the owner's `DIRECTIVE_CREATE_FENCE` constant instead of the agent row's updatedAt, so
   * it survives unrelated agent writes made between drafting and apply. Consumers must persist this
   * fence unchanged.
   */
  async draftForProposal(
    workspaceId: string,
    agentId: string,
    input: DirectiveAuthorDraftInput,
  ): Promise<{ draft: DirectiveAuthorDraftResult; versionToken: string; current: import("../authoredDirectives.js").AuthoredDirective | null }> {
    return this.draftWithFence(workspaceId, agentId, input);
  }

  async readProposalFence(workspaceId: string, agentId: string, directiveId: string | null): Promise<string> {
    await this.requireAgent(workspaceId, agentId);
    if (!directiveId) return DIRECTIVE_CREATE_FENCE;
    const directive = (await this.options.repository.listDirectives(agentId, workspaceId)).find((item) => item.id === directiveId);
    if (!directive) throw notFound("Directive not found");
    return directive.updatedAt.toISOString();
  }

  private async draftWithFence(
    workspaceId: string,
    agentId: string,
    input: DirectiveAuthorDraftInput,
  ): Promise<{ draft: DirectiveAuthorDraftResult; versionToken: string; current: import("../authoredDirectives.js").AuthoredDirective | null }> {
    const parsedInput = directiveAuthorDraftInputSchema.parse(input);
    const agent = await this.requireAgent(workspaceId, agentId);
    const existingDirectives = await this.options.repository.listDirectives(agentId, workspaceId);
    const existing = parsedInput.directiveId
      ? existingDirectives.find((directive) => directive.id === parsedInput.directiveId)
      : undefined;
    if (parsedInput.directiveId && !existing) {
      throw notFound("Directive not found");
    }
    const versionToken = existing ? existing.updatedAt.toISOString() : DIRECTIVE_CREATE_FENCE;
    const existingFields = existing ? {
      name: existing.name,
      condition: existing.condition,
      action: existing.action,
      priority: existing.priority,
      excludes: existing.excludes,
      tags: existing.tags,
      surfaces: existing.surfaces,
    } : undefined;
    const suppliedFields = parsedInput.fields ?? {};
    const completeFields = { ...existingFields, ...suppliedFields };
    const missing = ["name", "condition", "action"].filter((field) => completeFields[field as keyof typeof completeFields] === undefined);
    const explicitDirective = hasRequiredDirectiveFields(suppliedFields);

    // An edit starts from the persisted directive, so an exact structured edit may preserve every
    // omitted field. Intent is different: inherited fields must not suppress the coach unless the
    // caller explicitly supplied a complete directive to use verbatim.
    if (missing.length === 0 && hasRequiredDirectiveFields(completeFields) && (!parsedInput.coachingText || explicitDirective)) {
      const result = this.finalizeDraft({
        directive: { ...completeFields, tags: existing?.tags ?? [], surfaces: existing?.surfaces ?? [] },
        diagnosis: "directive_recommended",
      }, parsedInput);
      this.validateReplacementNames(result.directive.excludes ?? [], existingDirectives);
      return { draft: result, versionToken, current: existing ?? null };
    }
    if (!parsedInput.coachingText || !parsedInput.turn) {
      throw badRequest(`A directive without intent needs ${missing.join(" and ")}.`);
    }
    const requestId = randomUUID();
    const prompt = this.buildPrompt(agent, parsedInput, suppliedFields);

    const primary = await this.callLlm({
      workspaceId,
      agentId,
      requestId,
      prompt,
      attemptKey: "primary",
    });
    const primaryDraft = parseDraft(primary);
    if (primaryDraft) {
      const result = this.finalizeDraft(primaryDraft, parsedInput, suppliedFields);
      this.validateReplacementNames(result.directive.excludes ?? [], existingDirectives);
      return { draft: result, versionToken, current: existing ?? null };
    }

    const retry = await this.callLlm({
      workspaceId,
      agentId,
      requestId,
      prompt: `${prompt}\n\nReturn valid JSON only. Do not wrap it in markdown.`,
      attemptKey: "json_retry",
    });
    const retryDraft = parseDraft(retry);
    if (retryDraft) {
      const result = this.finalizeDraft(retryDraft, parsedInput, suppliedFields);
      this.validateReplacementNames(result.directive.excludes ?? [], existingDirectives);
      return { draft: result, versionToken, current: existing ?? null };
    }

    throw invalidDraftError();
  }

  private async requireAgent(workspaceId: string, agentId: string): Promise<DirectiveAuthorAgentContext> {
    const agent = await this.options.repository.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      throw notFound("Agent not found");
    }
    return agent;
  }

  private buildPrompt(
    agent: DirectiveAuthorAgentContext,
    input: DirectiveAuthorDraftInput,
    fixedFields: z.infer<typeof directiveAuthorStructuredFieldsSchema>,
  ): string {
    const template = loadPromptTemplate(PROMPT_PATH);
    return renderTemplate(template, {
      agent_context: serializePromptData({
        id: agent.id,
        name: agent.name,
        customInstruction: agent.customInstruction,
        greetingInstruction: agent.greetingInstruction,
      }),
      coaching_context: serializePromptData({
        coachingText: input.coachingText,
        turn: input.turn,
      }),
      fixed_fields: serializePromptData(fixedFields),
      scope_context: serializePromptData({
        activeRoutineId: input.turn?.activeRoutineId ?? null,
        activeStepId: input.turn?.activeStepId ?? null,
        defaultStepTag: input.turn?.activeRoutineId && input.turn.activeStepId
          ? this.options.buildStepScopeTag(input.turn.activeRoutineId, input.turn.activeStepId)
          : null,
      }),
    });
  }

  private async callLlm(input: {
    workspaceId: string;
    agentId: string;
    requestId: string;
    prompt: string;
    attemptKey: string;
  }): Promise<string> {
    const startedAt = Date.now();
    const baseFields = {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      requestId: input.requestId,
      attemptKey: input.attemptKey,
      promptLength: input.prompt.length,
    };

    this.options.logger.info(baseFields, "directive_author_llm_call_started");

    try {
      const text = await traceOperation({
        name: "agents.directive_author.llm_call",
        attributes: {
          "radioso.workspace_id": input.workspaceId,
          "radioso.agent_id": input.agentId,
          "radioso.request_id": input.requestId,
          "radioso.attempt_key": input.attemptKey,
          "radioso.prompt_length": input.prompt.length,
        },
        run: () => this.options.textGenerationClient.complete({
          operation: {
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            requestId: input.requestId,
            surface: "agents",
            operation: "draft_directive",
            attemptKey: input.attemptKey,
          },
          prompt: input.prompt,
          temperature: 0,
          maxOutputTokens: 900,
        }),
        resultAttributes: (text) => {
          const draft = parseDraft(text);
          return {
            "radioso.status": "success",
            "radioso.diagnosis": draft?.diagnosis ?? "unknown",
          };
        },
      });
      const durationMs = Date.now() - startedAt;
      const draft = parseDraft(text);
      await this.emitTelemetry({
        ...baseFields,
        durationMs,
        status: "success",
        diagnosis: draft?.diagnosis ?? "unknown",
      });
      this.options.logger.info({
        ...baseFields,
        durationMs,
        status: "success",
        diagnosis: draft?.diagnosis ?? "unknown",
        completionLength: text.length,
      }, "directive_author_llm_call_completed");
      return text;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      await this.emitTelemetry({
        ...baseFields,
        durationMs,
        status: "failure",
        diagnosis: "unknown",
      });
      this.options.logger.warn({
        ...baseFields,
        durationMs,
        status: "failure",
        err: error instanceof Error ? error.name : "unknown",
      }, "directive_author_llm_call_failed");
      throw error;
    }
  }

  private finalizeDraft(
    draft: DirectiveAuthorDraftResult,
    input: DirectiveAuthorDraftInput,
    fixedFields: z.infer<typeof directiveAuthorStructuredFieldsSchema> = {},
  ): DirectiveAuthorDraftResult {
    return {
      ...draft,
      directive: {
        ...draft.directive,
        ...fixedFields,
        tags: defaultTags(draft, input, this.options.buildStepScopeTag),
      },
    };
  }

  private validateReplacementNames(excludes: string[], existingDirectives: ReadonlyArray<{ name: string }>): void {
    const validation = validateDirectiveReplacementNames(excludes, existingDirectives);
    if (validation.unknown.length > 0) {
      throw badRequest(`Unknown directive replacement ${validation.unknown.join(", ")}. Valid names: ${validation.validNames.slice(0, 20).join(", ")}.`);
    }
  }

  private async emitTelemetry(input: {
    workspaceId: string;
    agentId: string;
    requestId: string;
    attemptKey: string;
    promptLength: number;
    durationMs: number;
    status: "success" | "failure";
    diagnosis: string;
  }): Promise<void> {
    await this.options.telemetryService?.emit({
      eventType: "agents.directive_author.llm_call",
      severity: input.status === "success" ? "info" : "warn",
      correlation: {
        workspaceId: input.workspaceId,
      },
      metrics: {
        durationMs: input.durationMs,
        promptLength: input.promptLength,
      },
      tags: {
        status: input.status,
        diagnosis: input.diagnosis,
        attempt_key: input.attemptKey,
      },
      metadata: {
        agentId: input.agentId,
        requestId: input.requestId,
      },
    }).catch(() => undefined);
  }
}
