import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type {
  JsonSchemaResponseFormat,
  TextGenerationRequest,
  TextGenerationResult,
} from "../../../shared/infra/llm/providerTypes.js";
import type { TurnDeclineReason } from "./assistantTurnOutcomeTypes.js";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { SteeringRule } from "../../../shared/domain/steeringRule.js";
import { loadPromptTemplate, renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { isProviderCredentialError } from "../../../shared/infra/llm/providerErrors.js";
import type { ChatGatewayUsageContext } from "../contracts/chatGateway.js";
import { resolveChatLocale } from "./chatLocale.js";
import { appendSteeringBlock } from "../../../shared/infra/prompts/steeringPromptRenderer.js";

export interface FallbackReplyInput {
  query: string;
  userExpectedLocale?: string | null;
  answerInstructionBlock?: string;
  steering?: SteeringRule[];
  workspaceContext?: LlmCapabilityResolveInput;
  usageContext: ChatGatewayUsageContext;
  signal?: AbortSignal;
}

/**
 * A composed decline plus why the turn declined. Every non-model path reports
 * `content_gap`: without a model judgement there is no positive evidence that the
 * request was outside the agent's remit, and the conservative default keeps the
 * turn inside the grounding-gap queue rather than silently excusing it.
 */
export interface ComposedDecline {
  text: string;
  declineReason: TurnDeclineReason;
}

export interface FallbackReplyComposer {
  composeNoContext(input: FallbackReplyInput): Promise<ComposedDecline>;
}

export class MissingFallbackReplyComposer implements FallbackReplyComposer {
  async composeNoContext(_input: FallbackReplyInput): Promise<ComposedDecline> {
    return contentGap(getGroundedMissFallback());
  }
}

const MAX_RESPONSE_LENGTH = CHAT_BEHAVIOR.groundedMiss.maxResponseLength;
const normalizeWhitespace = (value: string | undefined): string =>
  (value ?? "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

// Keep model-authored markdown structure, but strip citation artifacts and noisy spacing
// before the fallback response is shown to users.
const normalizeModelResponse = (value: string | undefined): string => {
  const normalized = (value ?? "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();

  if (!normalized || normalized.length > MAX_RESPONSE_LENGTH) {
    return "";
  }

  return normalized;
};

const buildLocaleInstruction = (userExpectedLocale?: string | null): string => {
  const locale = resolveChatLocale({ userExpectedLocale });
  return locale
    ? `Write the response in locale ${locale}. If the wording is ambiguous, prefer that locale over inferred query language.`
    : "Write the response in the same language as the user's question.";
};

const buildAnswerInstructionBlock = (answerInstructionBlock?: string): string => {
  const normalized = normalizeWhitespace(answerInstructionBlock);
  return normalized.length > 0 ? normalized : "No additional answer instructions.";
};

export const getGroundedMissFallback = (): string =>
  loadPromptTemplate("chat/grounded-miss-fallback.md").trim();

const contentGap = (text: string): ComposedDecline => ({ text, declineReason: "content_gap" });

const DECLINE_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  name: "grounded_miss_decline",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["reply", "declineReason"],
    properties: {
      reply: {
        type: "string",
        description: "The visible decline text only. No bullets, headings, citations, or commentary.",
      },
      declineReason: { type: "string", enum: ["content_gap", "out_of_scope"] },
    },
  },
};

/**
 * Reads the strict decline object. Providers without API-level schema enforcement can
 * still return bare prose, so text that never claimed to be an envelope degrades to the
 * raw reply as a content gap rather than failing the turn or inventing a scope judgement.
 *
 * Text that *does* open as an envelope but does not parse is discarded instead: the
 * token cap has to cover a reasoning pass as well as the reply, so a half-written object
 * is a real outcome here, and showing a visitor `{"reply":"I can't help with th` is worse
 * than the canned decline the empty result falls through to.
 */
const readComposedDecline = (raw: string | undefined): ComposedDecline => {
  const trimmed = (raw ?? "").trim();
  if (!trimmed.startsWith("{")) {
    return contentGap(trimmed);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return contentGap("");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return contentGap("");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.reply !== "string") {
    return contentGap("");
  }
  return {
    text: record.reply,
    declineReason: record.declineReason === "out_of_scope" ? "out_of_scope" : "content_gap",
  };
};

const buildGroundedMissSystemPrompt = (input: FallbackReplyInput): string =>
  appendSteeringBlock(
    renderPromptTemplate("chat/grounded-miss.md", {
      decline_rules: loadPromptTemplate("chat/grounded-decline-rules.md"),
      locale_instruction: buildLocaleInstruction(input.userExpectedLocale),
      answer_instruction_block: buildAnswerInstructionBlock(input.answerInstructionBlock),
    }),
    input.steering,
  );

export class ModelFallbackReplyComposer implements FallbackReplyComposer {
  constructor(private readonly inference: ModelInferencePipeline) {}

  private async completeWithRetry(
    request: TextGenerationRequest,
    input: FallbackReplyInput,
  ): Promise<{ result: TextGenerationResult; attemptIndex: number }> {
    let lastError: unknown;
    for (let attemptIndex = 1; attemptIndex <= 2; attemptIndex += 1) {
      try {
        return {
          result: await this.inference.complete({
            operation: {
              ...input.usageContext,
              attemptKey: `${input.usageContext.attemptKey}:attempt:${attemptIndex}`,
            },
            ...request,
          }),
          attemptIndex,
        };
      } catch (error) {
        if (input.signal?.aborted) {
          throw input.signal.reason ?? error;
        }
        lastError = error;
      }
    }
    throw lastError;
  }

  async composeNoContext(input: FallbackReplyInput): Promise<ComposedDecline> {
    try {
      const request = {
        systemPrompt: buildGroundedMissSystemPrompt(input),
        prompt: input.query,
        temperature: CHAT_BEHAVIOR.groundedMiss.temperature,
        maxOutputTokens: CHAT_BEHAVIOR.groundedMiss.noContextMaxOutputTokens,
        // Short utility decline: keep reasoning spend minimal so the token budget
        // leaves room for visible text on reasoning models.
        reasoningEffort: "minimal" as const,
        responseFormat: DECLINE_RESPONSE_FORMAT,
        signal: input.signal,
      };
      const { result } = await this.completeWithRetry(request, input);

      const decline = readComposedDecline(result.text);
      const normalized = normalizeModelResponse(decline.text);
      if (normalized) {
        return { text: normalized, declineReason: decline.declineReason };
      }

      // A reply that failed the length or emptiness guard is discarded together with
      // its classification: the static asset is not the response the model judged.
      return contentGap(getGroundedMissFallback());
    } catch (error) {
      if (input.signal?.aborted) {
        throw input.signal.reason ?? error;
      }
      if (isProviderCredentialError(error)) {
        throw error;
      }

      return contentGap(getGroundedMissFallback());
    }
  }
}
