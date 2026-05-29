import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";
import type { TextGenerationClient, TextGenerationRequest } from "../../../shared/infra/llm/providerTypes.js";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { isProviderCredentialError } from "../../../shared/infra/llm/providerErrors.js";
import { resolveChatLocale } from "./chatLocale.js";

export interface GroundedMissNoContextInput {
  query: string;
  userExpectedLocale?: string | null;
  answerInstructionBlock?: string;
  workspaceContext?: LlmCapabilityResolveInput;
}

export interface GroundedMissResponseComposer {
  composeNoContext(input: GroundedMissNoContextInput): Promise<string>;
}

export class MissingGroundedMissResponseComposer implements GroundedMissResponseComposer {
  async composeNoContext(_input: GroundedMissNoContextInput): Promise<string> {
    return buildNoContextFallback();
  }
}

const MAX_RESPONSE_LENGTH = CHAT_BEHAVIOR.groundedMiss.maxResponseLength;

const normalizeWhitespace = (value: string | undefined): string =>
  (value ?? "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

let groundedMissTemplate: string | undefined;

const getGroundedMissTemplate = (): string => {
  groundedMissTemplate ??= loadPromptTemplate("chat/grounded-miss.md");
  return groundedMissTemplate;
};

const getGroundedMissPromptSection = (sectionName: string): string => {
  const sectionPattern = new RegExp(`--- ${sectionName} ---\\n([\\s\\S]*?)(?=\\n--- [a-z_]+ ---|$)`);
  const match = getGroundedMissTemplate().match(sectionPattern);
  if (!match?.[1]?.trim()) {
    throw new Error(`Missing grounded miss prompt section "${sectionName}"`);
  }

  return match[1].trimEnd();
};

const renderGroundedMissSection = (
  sectionName: string,
  variables: Record<string, string>,
): string => {
  const template = getGroundedMissPromptSection(sectionName);

  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => {
    if (!(key in variables)) {
      throw new Error(`Missing prompt variable "${key}" for grounded miss section ${sectionName}`);
    }

    return variables[key] ?? "";
  });
};

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

const buildNoContextFallback = (): string => renderGroundedMissSection("fallback_no_context", {});

export class ModelGroundedMissResponseComposer implements GroundedMissResponseComposer {
  constructor(private readonly client: TextGenerationClient) {}

  private async completeWithRetry(request: TextGenerationRequest): Promise<string | undefined> {
    try {
      return await this.client.complete(request);
    } catch {
      return this.client.complete(request);
    }
  }

  async composeNoContext(input: GroundedMissNoContextInput): Promise<string> {
    try {
      const raw = await this.completeWithRetry({
        prompt: renderGroundedMissSection("prompt", {
          locale_instruction: buildLocaleInstruction(input.userExpectedLocale),
          query: input.query,
          answer_instruction_block: buildAnswerInstructionBlock(input.answerInstructionBlock),
        }),
        temperature: CHAT_BEHAVIOR.groundedMiss.temperature,
        maxOutputTokens: CHAT_BEHAVIOR.groundedMiss.noContextMaxOutputTokens,
        // Short utility decline: keep reasoning spend minimal so the token budget
        // leaves room for visible text on reasoning models.
        reasoningEffort: "minimal",
      });

      const normalized = normalizeModelResponse(raw);
      if (normalized) {
        return normalized;
      }

      return buildNoContextFallback();
    } catch (error) {
      if (isProviderCredentialError(error)) {
        throw error;
      }

      return buildNoContextFallback();
    }
  }
}
