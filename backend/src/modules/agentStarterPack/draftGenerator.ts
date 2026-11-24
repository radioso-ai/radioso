import { randomUUID } from "node:crypto";

import { badRequest, AppError } from "../../shared/domain/errors.js";
import type { ModelCallUsageContext } from "../../shared/domain/modelCallUsageContext.js";
import { renderOutputLanguageInstruction } from "../../shared/domain/outputLanguageInstruction.js";
import { describeProviderFailure } from "../../shared/infra/llm/providerErrors.js";
import { renderPromptTemplate } from "../../shared/infra/prompts/promptLoader.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { TelemetryService } from "../../shared/observability/telemetry/telemetryService.js";
import { traceOperation } from "../../shared/observability/tracing/operations.js";
import type {
  ResponseLanguageDetection,
  ResponseLanguageDetector,
} from "../../shared/services/responseLanguageDetector.js";
import { defaultAnswerDirectives } from "../directives/public.js";
import {
  parseStarterPackDraftModelOutput,
  starterPackPurposeSchema,
  type StarterPackDraft,
} from "./contracts.js";

export const STARTER_PACK_DRAFT_PROMPT_PATH = "agent-setup/starter-pack-draft.md";

const SURFACE = "agent_starter_pack";

interface StarterPackTextGenerationPort {
  complete(input: {
    operation: ModelCallUsageContext;
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface StarterPackAgentContext {
  id: string;
  name: string;
  customInstruction?: string | null;
  greetingInstruction?: string | null;
}

interface StarterPackDraftGeneratorOptions {
  textGenerationClient: StarterPackTextGenerationPort;
  languageDetector: ResponseLanguageDetector;
  logger: Pick<AppLogger, "info" | "warn">;
  telemetryService?: Pick<TelemetryService, "emit">;
}

interface StarterPackDraftGenerationInput {
  workspaceId: string;
  agent: StarterPackAgentContext;
  purpose: string;
  existingDirectiveNames?: readonly string[];
  existingRoutineNames?: readonly string[];
  signal?: AbortSignal;
}

const reservedDirectiveNames = (): string[] => defaultAnswerDirectives.map((directive) => directive.name);

// Untrusted text is placed inside these tag-delimited blocks in the template. Removing the tags
// themselves from that text keeps it from closing its block early and posing as instructions.
// A tag counts however it is spaced, cased, or attributed (`< /purpose>`, `</PURPOSE x="1">`,
// newlines inside it). Removal repeats until nothing changes, so a tag split around another
// (`<</purpose>/purpose>`) cannot reassemble once the inner one is gone.
//
// Each form is bounded so that prose like `<purpose of the call>` survives: a closing tag takes no
// `<` or `>` and stays on its line; an opening tag is bare, self-closing, or carries `name=value`
// attributes. Serialized data is stripped per string value, before JSON encoding, so a match can
// never span JSON structure.
const BLOCK_NAMES = "(?:purpose|agent_context|names_in_use)";
const ATTRIBUTE_VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[^\s"'<>=]+)`;
const PROMPT_BLOCK_TAG = new RegExp(
  [
    String.raw`<\s*\/\s*${BLOCK_NAMES}\b[^<>\n]*\s*>`,
    String.raw`<\s*${BLOCK_NAMES}(?:\s+[\w:-]+\s*=\s*${ATTRIBUTE_VALUE})*\s*\/?\s*>`,
  ].join("|"),
  "giu",
);

const stripPromptBlockTags = (value: string): string => {
  let previous: string;
  let current = value;
  do {
    previous = current;
    current = previous.replace(PROMPT_BLOCK_TAG, "");
  } while (current !== previous);
  return current;
};

const serializePromptData = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (typeof item === "string" ? stripPromptBlockTags(item) : item), 2);

const cleanJsonCompletion = (raw: string): string =>
  raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

type StarterPackDraftParse = ReturnType<typeof parseStarterPackDraftModelOutput>;

export const parseStarterPackDraft = (raw: string): StarterPackDraftParse => {
  let value: unknown;
  try {
    value = JSON.parse(cleanJsonCompletion(raw));
  } catch {
    return null;
  }
  return parseStarterPackDraftModelOutput(value);
};

export const buildStarterPackDraftPrompt = (input: {
  agent: StarterPackAgentContext;
  purpose: string;
  outputLanguageInstruction: string;
  existingDirectiveNames?: readonly string[];
  existingRoutineNames?: readonly string[];
}): string =>
  renderPromptTemplate(STARTER_PACK_DRAFT_PROMPT_PATH, {
    output_language_instruction: input.outputLanguageInstruction,
    agent_context: serializePromptData({
      id: input.agent.id,
      name: input.agent.name,
      customInstruction: input.agent.customInstruction ?? null,
      greetingInstruction: input.agent.greetingInstruction ?? null,
    }),
    names_in_use: serializePromptData({
      directives: [...(input.existingDirectiveNames ?? []), ...reservedDirectiveNames()],
      routines: [...(input.existingRoutineNames ?? [])],
    }),
    purpose: stripPromptBlockTags(input.purpose),
  });

export const invalidStarterPackDraftError = (): AppError =>
  new AppError(
    422,
    "invalid_starter_pack_draft",
    "The starter pack could not be drafted as valid JSON. Try again or rephrase the purpose.",
  );

/**
 * Turns an agent purpose, in any language, into suggested directives plus exactly one routine.
 * It only drafts: nothing is saved or published here.
 */
export class StarterPackDraftGenerator {
  constructor(private readonly options: StarterPackDraftGeneratorOptions) {}

  async generate(input: StarterPackDraftGenerationInput): Promise<StarterPackDraft> {
    const purpose = this.parsePurpose(input.purpose);
    const requestId = randomUUID();

    const detection = await this.detectOutputLanguage(input.workspaceId, input.agent.id, requestId, purpose, input.signal);
    const outputLanguage = detection.responseLanguage ?? null;

    const prompt = buildStarterPackDraftPrompt({
      agent: input.agent,
      purpose,
      outputLanguageInstruction: renderOutputLanguageInstruction(detection.responseLanguage),
      existingDirectiveNames: input.existingDirectiveNames,
      existingRoutineNames: input.existingRoutineNames,
    });

    const attempts = [
      { attemptKey: "primary", prompt },
      { attemptKey: "json_retry", prompt: `${prompt}\n\nReturn valid JSON only. Do not wrap it in markdown. Include exactly one routine object.` },
    ];
    for (const attempt of attempts) {
      const parsed = await this.callLlm({
        workspaceId: input.workspaceId,
        agentId: input.agent.id,
        requestId,
        attemptKey: attempt.attemptKey,
        prompt: attempt.prompt,
        outputLanguage,
        signal: input.signal,
      });
      if (parsed) {
        return { ...parsed.draft, outputLanguage };
      }
      this.options.logger.warn({
        workspaceId: input.workspaceId,
        agentId: input.agent.id,
        requestId,
        attemptKey: attempt.attemptKey,
        failureMode: "schema_mismatch",
      }, "starter_pack_draft_schema_mismatch");
    }
    throw invalidStarterPackDraftError();
  }

  /**
   * Detection only picks the output language. If its model call fails, the draft goes ahead with
   * the "same language as the purpose" instruction instead of failing the whole request. An
   * aborted request stops here instead: nobody is waiting for the draft.
   */
  private async detectOutputLanguage(
    workspaceId: string,
    agentId: string,
    requestId: string,
    purpose: string,
    signal: AbortSignal | undefined,
  ): Promise<ResponseLanguageDetection> {
    try {
      return await this.options.languageDetector.detect({
        query: purpose,
        history: [],
        signal,
        workspaceContext: { workspaceId },
        usageContext: {
          workspaceId,
          agentId,
          requestId,
          surface: SURFACE,
          operation: "response_language_detection",
          attemptKey: "response_language",
        },
      });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      this.options.logger.warn(
        { workspaceId, agentId, requestId, ...describeProviderFailure(error) },
        "starter_pack_language_detection_failed",
      );
      return {};
    }
  }

  private parsePurpose(purpose: string): string {
    const parsed = starterPackPurposeSchema.safeParse(purpose);
    if (!parsed.success) {
      throw badRequest("Describe the agent's purpose in 1 to 4000 characters.", parsed.error.flatten());
    }
    return parsed.data;
  }

  private async callLlm(input: {
    workspaceId: string;
    agentId: string;
    requestId: string;
    attemptKey: string;
    prompt: string;
    outputLanguage: string | null;
    signal?: AbortSignal;
  }): Promise<StarterPackDraftParse> {
    const startedAt = Date.now();
    // Never log or trace the prompt, purpose, or suggestion text: it is operator-authored content.
    const baseFields = {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      requestId: input.requestId,
      attemptKey: input.attemptKey,
      promptLength: input.prompt.length,
    };
    this.options.logger.info(baseFields, "starter_pack_draft_llm_call_started");

    try {
      const { text, parsed } = await traceOperation({
        name: "agent_starter_pack.draft.llm_call",
        attributes: {
          "radioso.workspace_id": input.workspaceId,
          "radioso.agent_id": input.agentId,
          "radioso.request_id": input.requestId,
          "radioso.attempt_key": input.attemptKey,
          "radioso.prompt_length": input.prompt.length,
          "radioso.output_language_detected": input.outputLanguage !== null,
        },
        run: async () => {
          const completion = await this.options.textGenerationClient.complete({
            operation: {
              workspaceId: input.workspaceId,
              agentId: input.agentId,
              requestId: input.requestId,
              surface: SURFACE,
              operation: "draft_starter_pack",
              attemptKey: input.attemptKey,
            },
            prompt: input.prompt,
            temperature: 0,
            // A full pack is six directives of up to 4,000 characters each plus the procedure
            // prose, and a reasoning model spends part of the budget before it writes; the
            // routine draft assist uses the same budget.
            maxOutputTokens: 4_000,
            signal: input.signal,
          });
          return { text: completion, parsed: parseStarterPackDraft(completion) };
        },
        resultAttributes: (result) => ({
          "radioso.status": "success",
          "radioso.parsed": result.parsed !== null,
          "radioso.dropped_directive_count": result.parsed?.droppedDirectiveCount ?? 0,
        }),
      });
      const durationMs = Date.now() - startedAt;
      const outcome = { parsed: parsed !== null, droppedDirectiveCount: parsed?.droppedDirectiveCount ?? 0 };
      await this.emitTelemetry({ ...baseFields, durationMs, status: "success", ...outcome });
      this.options.logger.info({
        ...baseFields,
        durationMs,
        status: "success",
        ...outcome,
        completionLength: text.length,
      }, "starter_pack_draft_llm_call_completed");
      return parsed;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (input.signal?.aborted) {
        // The caller went away; the provider did not fail.
        await this.emitTelemetry({ ...baseFields, durationMs, status: "aborted", parsed: false, droppedDirectiveCount: 0 });
        this.options.logger.info({ ...baseFields, durationMs, status: "aborted" }, "starter_pack_draft_llm_call_aborted");
        throw error;
      }
      await this.emitTelemetry({ ...baseFields, durationMs, status: "failure", parsed: false, droppedDirectiveCount: 0 });
      this.options.logger.warn({
        ...baseFields,
        durationMs,
        status: "failure",
        ...describeProviderFailure(error),
      }, "starter_pack_draft_llm_call_failed");
      throw error;
    }
  }

  private async emitTelemetry(input: {
    workspaceId: string;
    agentId: string;
    requestId: string;
    attemptKey: string;
    promptLength: number;
    durationMs: number;
    status: "success" | "failure" | "aborted";
    parsed: boolean;
    droppedDirectiveCount: number;
  }): Promise<void> {
    await this.options.telemetryService?.emit({
      eventType: "agent_starter_pack.draft.llm_call",
      severity: input.status === "failure" ? "warn" : "info",
      correlation: { workspaceId: input.workspaceId },
      metrics: { durationMs: input.durationMs, promptLength: input.promptLength, droppedDirectiveCount: input.droppedDirectiveCount },
      tags: {
        status: input.status,
        parsed: String(input.parsed),
        attempt_key: input.attemptKey,
      },
      metadata: { agentId: input.agentId, requestId: input.requestId },
    }).catch(() => undefined);
  }
}
