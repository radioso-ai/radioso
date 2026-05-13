import {
  buildResponseIdentityLines,
  type ResponseIdentity,
} from "../../../shared/domain/responseIdentity.js";
import { normalizeLlmClassifierLanguageLabel } from "../../../shared/domain/llmClassifierFields.js";
import type { ResponseLanguagePolicy } from "../domain/retrievalPipelineTypes.js";

export interface SharedAnswerInstructionBlocks {
  responseIdentityBlock: string | null;
  customInstructionBlock: string | null;
  responseLanguageInstruction: string;
}

export interface SharedAnswerInstructionInput {
  responseIdentity?: ResponseIdentity | null;
  customInstruction?: string;
  responseLanguagePolicy?: ResponseLanguagePolicy;
  responseLanguage?: string;
}

export class SharedAnswerInstructionBuilder {
  build(input: SharedAnswerInstructionInput): SharedAnswerInstructionBlocks {
    return {
      responseIdentityBlock: this.renderResponseIdentity(input.responseIdentity),
      customInstructionBlock: this.renderCustomInstruction(input.customInstruction),
      responseLanguageInstruction: this.renderResponseLanguageInstruction(
        input.responseLanguagePolicy ?? "match_user_question",
        input.responseLanguage,
      ),
    };
  }

  buildCombinedBlock(input: SharedAnswerInstructionInput): string {
    const blocks = this.build(input);

    return [
      blocks.responseIdentityBlock,
      blocks.customInstructionBlock,
      blocks.responseLanguageInstruction,
    ]
      .filter((block): block is string => Boolean(block))
      .join("\n\n");
  }

  buildScopeReferenceBlock(input: Pick<SharedAnswerInstructionInput, "responseIdentity" | "customInstruction">): string {
    return [
      this.renderResponseIdentity(input.responseIdentity),
      this.renderCustomInstruction(input.customInstruction),
    ]
      .filter((block): block is string => Boolean(block))
      .join("\n\n");
  }

  private renderCustomInstruction(customInstruction?: string): string | null {
    if (!customInstruction) {
      return null;
    }

    const sanitized = customInstruction.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    if (!sanitized.trim()) {
      return null;
    }

    return `Configured response instructions:\n${sanitized}`;
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
      "Stable response identity:",
      ...identityLines,
      "When the caller asks about the configured name, answer consistently with this identity.",
    ].join("\n");
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
