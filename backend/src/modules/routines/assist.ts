import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { AgentRepositoryPort } from "../../db/repositories/agentRepository.js";
import type { ModelCallUsageContext } from "../../shared/domain/modelCallUsageContext.js";
import { AppError, notFound } from "../../shared/domain/errors.js";
import { loadPromptTemplate } from "../../shared/infra/prompts/promptLoader.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { TelemetryService } from "../../shared/observability/telemetry/telemetryService.js";
import { traceOperation } from "../../shared/observability/tracing/operations.js";
import {
  routineDefinitionDraftInputSchema,
  type RoutineDefinition,
  type RoutineDefinitionDraftInput,
} from "./domain.js";
import {
  validateRoutineDefinition,
  type RoutineValidationDiagnostic,
  type RoutineValidationResult,
} from "./validator.js";

export interface RoutineDraftAssistTextGenerationPort {
  complete(input: {
    operation: ModelCallUsageContext;
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

export const routineDraftAssistRequestSchema = z.object({
  prose: z.string().trim().min(1).max(50_000),
}).strict();

export const routineDraftAssistActionCatalogEntrySchema = z.object({
  type: z.string().trim().min(1).max(300),
  kind: z.enum(["action", "tool"]).default("action"),
  label: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(1_000).optional(),
  outcomeStatuses: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
}).strict();

export const routineDraftAssistResponseSchema = z.object({
  draft: routineDefinitionDraftInputSchema,
  validation: z.object({
    ok: z.boolean(),
    diagnostics: z.array(z.object({
      code: z.string(),
      location: z.string(),
      message: z.string(),
    })),
  }),
}).strict();

export type RoutineDraftAssistRequest = z.infer<typeof routineDraftAssistRequestSchema>;
export type RoutineDraftAssistActionCatalogEntry = z.infer<typeof routineDraftAssistActionCatalogEntrySchema>;
export type RoutineDraftAssistResponse = {
  draft: RoutineDefinitionDraftInput;
  validation: RoutineValidationResult;
};

type RoutineDraftAssistAgentContext = {
  id: string;
  name: string;
  customInstruction?: string | null;
  greetingInstruction?: string | null;
};

export interface RoutineDraftAssistServiceOptions {
  repository: Pick<AgentRepositoryPort, "findByIdAndWorkspaceId">;
  textGenerationClient: RoutineDraftAssistTextGenerationPort;
  actionCatalog: RoutineDraftAssistActionCatalogEntry[];
  logger: Pick<AppLogger, "info" | "warn">;
  telemetryService?: Pick<TelemetryService, "emit">;
}

const PROMPT_PATH = "routines/draft-document.md";

const cleanJsonCompletion = (raw: string): string =>
  raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

const renderTemplate = (template: string, variables: Record<string, string>): string =>
  template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => {
    if (!(key in variables)) {
      throw new Error(`Missing prompt variable "${key}" for template ${PROMPT_PATH}`);
    }
    return variables[key] ?? "";
  });

const serializePromptData = (value: unknown): string => JSON.stringify(value, null, 2);

const parseDraft = (raw: string): RoutineDefinitionDraftInput | null => {
  try {
    const parsed = JSON.parse(cleanJsonCompletion(raw)) as unknown;
    const container = z.object({ draft: routineDefinitionDraftInputSchema }).strict().safeParse(parsed);
    return container.success ? container.data.draft : null;
  } catch {
    return null;
  }
};

const draftDefinitionFromInput = (
  agentId: string,
  input: RoutineDefinitionDraftInput,
): RoutineDefinition => ({
  id: randomUUID(),
  agentId,
  version: 1,
  status: "draft",
  ...input,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const invalidDraftError = () =>
  new AppError(
    422,
    "invalid_routine_draft_assist",
    "The routine draft could not be generated as a valid routine draft. Try again or revise the procedure text.",
  );

const catalogDiagnostics = (
  draft: RoutineDefinitionDraftInput,
  catalog: RoutineDraftAssistActionCatalogEntry[],
): RoutineValidationDiagnostic[] => {
  const entriesByType = new Map(catalog.map((entry) => [entry.type, entry]));
  const diagnostics: RoutineValidationDiagnostic[] = [];

  for (const step of draft.steps) {
    if (step.kind === "action") {
      if (!step.actionType || !entriesByType.has(step.actionType)) {
        diagnostics.push({
          code: "unregistered_action_type",
          location: `step:${step.stableStepId}`,
          message: `unregistered action type: action step "${step.stableStepId}" references "${step.actionType ?? ""}", but that action is not in the permitted action catalog.`,
        });
      }
      continue;
    }
    if (step.kind === "tool") {
      if (!step.toolRef || !entriesByType.has(step.toolRef)) {
        diagnostics.push({
          code: "unregistered_action_type",
          location: `step:${step.stableStepId}`,
          message: `unregistered action type: tool step "${step.stableStepId}" references "${step.toolRef ?? ""}", but that action is not in the permitted action catalog.`,
        });
      }
    }
  }

  return diagnostics;
};

export class RoutineDraftAssistService {
  private readonly actionCatalog: RoutineDraftAssistActionCatalogEntry[];

  constructor(private readonly options: RoutineDraftAssistServiceOptions) {
    this.actionCatalog = options.actionCatalog.map((entry) =>
      routineDraftAssistActionCatalogEntrySchema.parse(entry)
    );
  }

  async draft(
    workspaceId: string,
    agentId: string,
    input: RoutineDraftAssistRequest,
  ): Promise<RoutineDraftAssistResponse> {
    const parsedInput = routineDraftAssistRequestSchema.parse(input);
    const agent = await this.requireAgent(workspaceId, agentId);
    const requestId = randomUUID();
    const prompt = this.buildPrompt(agent, parsedInput);

    const primary = await this.callLlm({
      workspaceId,
      agentId,
      requestId,
      prompt,
      proseLength: parsedInput.prose.length,
      attemptKey: "primary",
    });
    const primaryDraft = parseDraft(primary);
    if (primaryDraft) {
      return this.finalizeDraft(agentId, primaryDraft);
    }

    this.options.logger.warn({
      workspaceId,
      agentId,
      requestId,
      failureMode: "schema_mismatch",
      attemptKey: "primary",
    }, "routine_draft_assist_schema_mismatch");

    const retry = await this.callLlm({
      workspaceId,
      agentId,
      requestId,
      prompt: `${prompt}\n\nReturn valid JSON only. Do not wrap it in markdown. The JSON must match the requested routine draft schema exactly.`,
      proseLength: parsedInput.prose.length,
      attemptKey: "schema_retry",
    });
    const retryDraft = parseDraft(retry);
    if (retryDraft) {
      return this.finalizeDraft(agentId, retryDraft);
    }

    this.options.logger.warn({
      workspaceId,
      agentId,
      requestId,
      failureMode: "schema_mismatch",
      attemptKey: "schema_retry",
    }, "routine_draft_assist_invalid_after_retry");
    throw invalidDraftError();
  }

  private async requireAgent(workspaceId: string, agentId: string): Promise<RoutineDraftAssistAgentContext> {
    const agent = await this.options.repository.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      throw notFound("Agent not found");
    }
    const record = agent as RoutineDraftAssistAgentContext;
    return {
      id: record.id,
      name: record.name,
      customInstruction: record.customInstruction ?? null,
      greetingInstruction: record.greetingInstruction ?? null,
    };
  }

  private buildPrompt(agent: RoutineDraftAssistAgentContext, input: RoutineDraftAssistRequest): string {
    const template = loadPromptTemplate(PROMPT_PATH);
    return renderTemplate(template, {
      agent_context: serializePromptData({
        id: agent.id,
        name: agent.name,
        customInstruction: agent.customInstruction ?? null,
        greetingInstruction: agent.greetingInstruction ?? null,
      }),
      permitted_action_catalog: serializePromptData(this.actionCatalog),
      procedure_text: input.prose,
    });
  }

  private async callLlm(input: {
    workspaceId: string;
    agentId: string;
    requestId: string;
    prompt: string;
    proseLength: number;
    attemptKey: string;
  }): Promise<string> {
    const startedAt = Date.now();
    const baseFields = {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      requestId: input.requestId,
      attemptKey: input.attemptKey,
      promptLength: input.prompt.length,
      proseLength: input.proseLength,
      catalogSize: this.actionCatalog.length,
    };

    this.options.logger.info(baseFields, "routine_draft_assist_llm_call_started");

    try {
      const text = await traceOperation({
        name: "routines.draft_assist.llm_call",
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
            requestId: input.requestId,
            surface: "agents",
            operation: "draft_routine",
            attemptKey: input.attemptKey,
          },
          prompt: input.prompt,
          temperature: 0,
          maxOutputTokens: 4_000,
        }),
        resultAttributes: (text) => ({
          "radioso.status": parseDraft(text) ? "success" : "schema_mismatch",
        }),
      });
      const durationMs = Date.now() - startedAt;
      await this.emitTelemetry({
        ...baseFields,
        durationMs,
        status: "success",
        failureMode: parseDraft(text) ? "none" : "schema_mismatch",
      });
      this.options.logger.info({
        ...baseFields,
        durationMs,
        status: "success",
        failureMode: parseDraft(text) ? "none" : "schema_mismatch",
        completionLength: text.length,
      }, "routine_draft_assist_llm_call_completed");
      return text;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      await this.emitTelemetry({
        ...baseFields,
        durationMs,
        status: "failure",
        failureMode: "provider_error",
      });
      this.options.logger.warn({
        ...baseFields,
        durationMs,
        status: "failure",
        failureMode: "provider_error",
        err: error instanceof Error ? error.name : "unknown",
      }, "routine_draft_assist_llm_call_failed");
      throw error;
    }
  }

  private finalizeDraft(agentId: string, draft: RoutineDefinitionDraftInput): RoutineDraftAssistResponse {
    const validation = validateRoutineDefinition(draftDefinitionFromInput(agentId, draft));
    const catalogValidationDiagnostics = catalogDiagnostics(draft, this.actionCatalog);
    const diagnostics = [...validation.diagnostics, ...catalogValidationDiagnostics];
    return {
      draft,
      validation: {
        ok: diagnostics.length === 0,
        diagnostics,
      },
    };
  }

  private async emitTelemetry(input: {
    workspaceId: string;
    agentId: string;
    requestId: string;
    attemptKey: string;
    promptLength: number;
    proseLength: number;
    catalogSize: number;
    durationMs: number;
    status: "success" | "failure";
    failureMode: string;
  }): Promise<void> {
    await this.options.telemetryService?.emit({
      eventType: "routines.draft_assist.llm_call",
      severity: input.status === "success" ? "info" : "warn",
      correlation: {
        workspaceId: input.workspaceId,
      },
      metrics: {
        durationMs: input.durationMs,
        promptLength: input.promptLength,
        proseLength: input.proseLength,
        catalogSize: input.catalogSize,
      },
      tags: {
        status: input.status,
        attempt_key: input.attemptKey,
        failure_mode: input.failureMode,
      },
      metadata: {
        agentId: input.agentId,
        requestId: input.requestId,
      },
    }).catch(() => undefined);
  }
}
