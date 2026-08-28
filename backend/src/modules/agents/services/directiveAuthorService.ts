import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { AgentRepositoryPort } from "../../../db/repositories/agentRepository.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import { AppError, notFound } from "../../../shared/domain/errors.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { authoredDirectiveSurfaceValues } from "../authoredDirectives.js";
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
  "id" | "name" | "customInstruction" | "greetingInstruction"
>;

export const directiveAuthorTurnSchema = z.object({
  userMessage: z.string().trim().min(1).max(20_000),
  assistantAnswer: z.string().trim().min(1).max(40_000),
  activeRoutineId: z.string().trim().min(1).max(200).optional(),
  activeStepId: z.string().trim().min(1).max(200).optional(),
}).strict();

export const directiveAuthorDraftInputSchema = z.object({
  coachingText: z.string().trim().min(1).max(20_000),
  turn: directiveAuthorTurnSchema,
}).strict();

export const directiveAuthorDraftSchema = z.object({
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
    tags: z.array(z.string().trim().min(1).max(200)).optional(),
    surfaces: z.array(z.enum(authoredDirectiveSurfaceValues)).optional(),
  }).strict(),
  diagnosis: z.enum(["directive_recommended", "knowledge_recommended_deferred"]),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict();

export type DirectiveAuthorDraftInput = z.infer<typeof directiveAuthorDraftInputSchema>;
export type DirectiveAuthorDraftResult = z.infer<typeof directiveAuthorDraftSchema>;

export interface DirectiveAuthorServiceOptions {
  repository: Pick<AgentRepositoryPort, "findByIdAndWorkspaceId">;
  textGenerationClient: DirectiveAuthorTextGenerationPort;
  logger: Pick<AppLogger, "info" | "warn">;
  telemetryService?: Pick<TelemetryService, "emit">;
  buildStepScopeTag: (routineId: string, stepId: string) => string;
}

const PROMPT_PATH = "coach/draft-directive.md";

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
  const { activeRoutineId, activeStepId } = input.turn;
  return activeRoutineId && activeStepId ? [buildStepScopeTag(activeRoutineId, activeStepId)] : [];
};

const invalidDraftError = () =>
  new AppError(
    422,
    "invalid_directive_draft",
    "The directive draft could not be generated as valid JSON. Try again or revise the coaching text.",
  );

export class DirectiveAuthorService {
  constructor(private readonly options: DirectiveAuthorServiceOptions) {}

  async draft(
    workspaceId: string,
    agentId: string,
    input: DirectiveAuthorDraftInput,
  ): Promise<DirectiveAuthorDraftResult> {
    const parsedInput = directiveAuthorDraftInputSchema.parse(input);
    const agent = await this.requireAgent(workspaceId, agentId);
    const requestId = randomUUID();
    const prompt = this.buildPrompt(agent, parsedInput);

    const primary = await this.callLlm({
      workspaceId,
      agentId,
      requestId,
      prompt,
      attemptKey: "primary",
    });
    const primaryDraft = parseDraft(primary);
    if (primaryDraft) {
      return this.finalizeDraft(primaryDraft, parsedInput);
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
      return this.finalizeDraft(retryDraft, parsedInput);
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

  private buildPrompt(agent: DirectiveAuthorAgentContext, input: DirectiveAuthorDraftInput): string {
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
      scope_context: serializePromptData({
        activeRoutineId: input.turn.activeRoutineId ?? null,
        activeStepId: input.turn.activeStepId ?? null,
        defaultStepTag: input.turn.activeRoutineId && input.turn.activeStepId
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
  ): DirectiveAuthorDraftResult {
    return {
      ...draft,
      directive: {
        ...draft.directive,
        tags: defaultTags(draft, input, this.options.buildStepScopeTag),
      },
    };
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
