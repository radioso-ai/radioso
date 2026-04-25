import {
  buildPublicAssistantIdentityLines,
  type AssistantIdentityPromptInput,
} from "../../settings/domain/assistantBootstrapSettings.js";
import type { ConversationMode } from "../../settings/domain/retrievalSettings.js";
import type { ResponseLanguagePolicy } from "../domain/retrievalPipelineTypes.js";
import { ConversationModeInstructionBuilder } from "./conversationModeInstructionBuilder.js";

export interface SharedAnswerInstructionBlocks {
  assistantIdentityBlock: string | null;
  customInstructionBlock: string | null;
  conversationModeInstructionBlock: string;
  responseLanguageInstruction: string;
}

export interface SharedAnswerInstructionInput {
  assistantIdentity?: AssistantIdentityPromptInput | null;
  customInstruction?: string;
  conversationMode?: ConversationMode;
  responseLanguagePolicy?: ResponseLanguagePolicy;
}

export class SharedAnswerInstructionBuilder {
  private readonly conversationModeInstructionBuilder = new ConversationModeInstructionBuilder();

  build(input: SharedAnswerInstructionInput): SharedAnswerInstructionBlocks {
    return {
      assistantIdentityBlock: this.renderAssistantIdentity(input.assistantIdentity),
      customInstructionBlock: this.renderCustomInstruction(input.customInstruction),
      conversationModeInstructionBlock: this.conversationModeInstructionBuilder.build({
        conversationMode: input.conversationMode ?? "guided",
      }),
      responseLanguageInstruction: this.renderResponseLanguageInstruction(
        input.responseLanguagePolicy ?? "match_user_question",
      ),
    };
  }

  buildCombinedBlock(input: SharedAnswerInstructionInput): string {
    const blocks = this.build(input);

    return [
      blocks.assistantIdentityBlock,
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

  private renderAssistantIdentity(assistantIdentity?: AssistantIdentityPromptInput | null): string | null {
    if (!assistantIdentity) {
      return null;
    }

    const identityLines = buildPublicAssistantIdentityLines(assistantIdentity);
    if (identityLines.length === 0) {
      return null;
    }

    return [
      "Stable assistant identity:",
      ...identityLines,
      "When the user asks about your name, role, or what you do, answer consistently with this identity.",
    ].join("\n");
  }

  private renderResponseLanguageInstruction(responseLanguagePolicy: ResponseLanguagePolicy): string {
    switch (responseLanguagePolicy) {
      case "match_user_question":
      default:
        return "Respond in the same language as the current user question. Do not switch to the language of the retrieved context or sources.";
    }
  }
}
