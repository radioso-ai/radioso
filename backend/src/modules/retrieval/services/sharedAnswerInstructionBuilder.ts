import {
  buildResponseIdentityLines,
  type ResponseIdentity,
} from "../../../shared/domain/responseIdentity.js";
import { renderCustomResponseInstructionBlock } from "../../../shared/domain/customResponseInstructionBlock.js";
import { normalizeLlmClassifierLanguageLabel } from "../../../shared/domain/llmClassifierFields.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
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
    return renderCustomResponseInstructionBlock(customInstruction);
  }

  private renderResponseIdentity(responseIdentity?: ResponseIdentity | null): string | null {
    if (!responseIdentity) {
      return null;
    }

    const identityLines = buildResponseIdentityLines(responseIdentity);
    if (identityLines.length === 0) {
      return null;
    }

    // Identity instructions live in prompts/shared/assistant-identity-instructions.md
    // and are shared with the direct-answer path. They keep the identity in
    // context every turn so tone stays stable, while limiting the
    // self-introduction to the first turn — re-greeting on every reply reads as
    // a memory failure, and conversation history already shows whether the
    // assistant has greeted.
    return renderPromptTemplate("shared/assistant-identity-instructions.md", {
      identity_lines: identityLines.join("\n"),
    });
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
