import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";
import type { ModelInferencePipeline } from "../../../shared/infra/llm/modelInferencePipeline.js";
import type {
  TextGenerationRequest,
  TextGenerationResult,
} from "../../../shared/infra/llm/providerTypes.js";
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

export interface FallbackReplyComposer {
  composeNoContext(input: FallbackReplyInput): Promise<string>;
}

export class MissingFallbackReplyComposer implements FallbackReplyComposer {
  async composeNoContext(_input: FallbackReplyInput): Promise<string> {
    return getGroundedMissFallback();
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

  async composeNoContext(input: FallbackReplyInput): Promise<string> {
    try {
      const request = {
        systemPrompt: buildGroundedMissSystemPrompt(input),
        prompt: input.query,
        temperature: CHAT_BEHAVIOR.groundedMiss.temperature,
        maxOutputTokens: CHAT_BEHAVIOR.groundedMiss.noContextMaxOutputTokens,
        // Short utility decline: keep reasoning spend minimal so the token budget
        // leaves room for visible text on reasoning models.
        reasoningEffort: "minimal" as const,
        signal: input.signal,
      };
      const { result } = await this.completeWithRetry(request, input);

      const normalized = normalizeModelResponse(result.text);
      if (normalized) {
        return normalized;
      }

      return getGroundedMissFallback();
    } catch (error) {
      if (input.signal?.aborted) {
        throw input.signal.reason ?? error;
      }
      if (isProviderCredentialError(error)) {
        throw error;
      }

      return getGroundedMissFallback();
    }
  }
}
