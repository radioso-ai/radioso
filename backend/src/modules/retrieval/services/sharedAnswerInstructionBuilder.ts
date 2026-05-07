import {
  buildResponseIdentityLines,
  type ResponseIdentity,
} from "../../../shared/domain/responseIdentity.js";
import type { ConversationMode } from "../../settings/contracts/retrieval.js";
import type { ResponseLanguagePolicy } from "../domain/retrievalPipelineTypes.js";
import { ConversationModeInstructionBuilder } from "./conversationModeInstructionBuilder.js";

export interface SharedAnswerInstructionBlocks {
  responseIdentityBlock: string | null;
  customInstructionBlock: string | null;
  conversationModeInstructionBlock: string | null;
  responseLanguageInstruction: string;
}

export interface SharedAnswerInstructionInput {
  responseIdentity?: ResponseIdentity | null;
  customInstruction?: string;
  conversationMode?: ConversationMode;
  responseLanguagePolicy?: ResponseLanguagePolicy;
}

export class SharedAnswerInstructionBuilder {
  private readonly conversationModeInstructionBuilder = new ConversationModeInstructionBuilder();

  build(input: SharedAnswerInstructionInput): SharedAnswerInstructionBlocks {
    return {
      responseIdentityBlock: this.renderResponseIdentity(input.responseIdentity),
      customInstructionBlock: this.renderCustomInstruction(input.customInstruction),
      conversationModeInstructionBlock: input.conversationMode
        ? this.conversationModeInstructionBuilder.build({ conversationMode: input.conversationMode })
        : null,
      responseLanguageInstruction: this.renderResponseLanguageInstruction(
        input.responseLanguagePolicy ?? "match_user_question",
      ),
    };
  }

  buildCombinedBlock(input: SharedAnswerInstructionInput): string {
    const blocks = this.build(input);

    return [
      blocks.responseIdentityBlock,
      blocks.customInstructionBlock,
      blocks.conversationModeInstructionBlock,
      blocks.responseLanguageInstruction,
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

    return `Workspace-specific instructions:\n${sanitized}`;
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

  private renderResponseLanguageInstruction(responseLanguagePolicy: ResponseLanguagePolicy): string {
    switch (responseLanguagePolicy) {
      case "match_user_question":
      default:
        return [
          "Respond in the same language as the current user question.",
          "If the current user question is too short or language-neutral, preserve the most recent explicit user language preference from the conversation.",
          "Do not switch to the language of the retrieved context or sources.",
        ].join(" ");
    }
  }
}
