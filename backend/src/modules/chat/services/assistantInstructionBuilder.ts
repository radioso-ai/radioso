import {
  buildResponseIdentityLines,
  type ResponseIdentity,
} from "../../../shared/domain/responseIdentity.js";
import { normalizeLlmClassifierLanguageLabel } from "../../../shared/domain/llmClassifierFields.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { ConversationModeInstructionBuilder, type ResponseLanguagePolicy } from "../../retrieval/public.js";
import type { ConversationMode } from "../../settings/contracts/retrieval.js";

export interface AssistantInstructionInput {
  responseIdentity?: ResponseIdentity | null;
  customInstruction?: string;
  conversationMode?: ConversationMode;
  responseLanguagePolicy?: ResponseLanguagePolicy;
  responseLanguage?: string;
}

export class AssistantInstructionBuilder {
  private readonly conversationModeInstructionBuilder = new ConversationModeInstructionBuilder();

  buildCombinedBlock(input: AssistantInstructionInput): string {
    return [
      this.renderResponseIdentity(input.responseIdentity),
      this.renderCustomInstruction(input.customInstruction),
      this.renderResponseFormattingGuidelines(),
      this.conversationModeInstructionBuilder.build({
        conversationMode: input.conversationMode ?? "exploratory",
      }),
      this.renderResponseLanguageInstruction(input.responseLanguagePolicy ?? "match_user_question", input.responseLanguage),
    ]
      .filter((block): block is string => Boolean(block))
      .join("\n\n");
  }

  private renderCustomInstruction(customInstruction?: string): string | null {
    if (!customInstruction) {
      return null;
    }

    const sanitized = customInstruction.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    return sanitized.trim() ? `Configured response instructions:\n${sanitized}` : null;
  }

  private renderResponseIdentity(responseIdentity?: ResponseIdentity | null): string | null {
    if (!responseIdentity) {
      return null;
    }

    const identityLines = buildResponseIdentityLines(responseIdentity);
    if (identityLines.length === 0) {
      return null;
    }

    return [
      "Stable assistant identity:",
      ...identityLines,
      "When the user asks about your name, answer consistently with this identity.",
    ].join("\n");
  }

  private renderResponseFormattingGuidelines(): string | null {
    const guidelines = loadPromptTemplate("chat/response-formatting-guidelines.md");
    return guidelines.trim() ? `Response formatting guidance:\n${guidelines}` : null;
  }

  private renderResponseLanguageInstruction(
    responseLanguagePolicy: ResponseLanguagePolicy,
    responseLanguage?: string,
  ): string {
    const safeResponseLanguage = normalizeLlmClassifierLanguageLabel(responseLanguage);
    switch (responseLanguagePolicy) {
      case "match_user_question":
      default:
        return safeResponseLanguage
          ? [
              `Respond in ${safeResponseLanguage}.`,
              `Translate source facts into ${safeResponseLanguage} when retrieved context or sources use another language.`,
              "Keep names, product labels, UI labels, URLs, and quoted source terms in their original language only when they are useful as labels or references.",
            ].join(" ")
          : [
              "Respond in the same language as the current user question.",
              "If the current user question is too short or language-neutral, preserve the most recent explicit user language preference from the conversation.",
              "Do not switch to the language of the retrieved context or sources.",
            ].join(" ");
    }
  }
}
