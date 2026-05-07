import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import type { ConversationMode } from "../../settings/contracts/retrieval.js";
import type { FinalPromptContext, ResponseLanguagePolicy } from "../domain/retrievalPipelineTypes.js";
import { resolveContextSourceUrl } from "./contextSourceUrl.js";
import { SharedAnswerInstructionBuilder } from "./sharedAnswerInstructionBuilder.js";

export interface PromptBuildResult {
  systemPrompt: string;
  prompt: string;
  citations: Array<{ documentId: string; chunkId: string; title: string }>;
}

export class PromptBuilder {
  constructor(
    private readonly sharedAnswerInstructionBuilder = new SharedAnswerInstructionBuilder(),
  ) {}

  build(input: {
    query: string;
    retrievalQuery?: string;
    history: MessageRecord[];
    contexts: FinalPromptContext[];
    settings: {
      responseIdentity?: ResponseIdentity | null;
      customInstruction?: string;
      conversationMode?: ConversationMode;
      responseLanguagePolicy?: ResponseLanguagePolicy;
    };
    intentTopic?: string;
    inScopeRequest?: string;
    outsideScopeRequest?: string;
  }): PromptBuildResult {
    const historySection = input.history
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n");
    const contextsSection = input.contexts
      .map((context, index) => {
        // Sanitize to prevent prompt injection via newlines or control characters.
        const rawSourceUrl = resolveContextSourceUrl(context.metadata) ?? "";
        const sanitizedSourceUrl = rawSourceUrl.replace(/[\n\r\t\x00-\x1f]/g, "").slice(0, 2048);
        const metadataLine = sanitizedSourceUrl ? `Source: ${sanitizedSourceUrl}\n` : "";
        return `Result ${index + 1} (${context.title}): ${metadataLine}${context.content}`;
      })
      .join("\n\n");
    const answerInstructionBlocks = this.sharedAnswerInstructionBuilder.build({
      responseIdentity: input.settings.responseIdentity,
      customInstruction: input.settings.customInstruction,
      conversationMode: input.settings.conversationMode,
      responseLanguagePolicy: input.settings.responseLanguagePolicy,
    });

    return {
      systemPrompt: renderPromptTemplate("retrieval/answer.md", {
        response_identity_block: answerInstructionBlocks.responseIdentityBlock
          ? `${answerInstructionBlocks.responseIdentityBlock}\n`
          : "",
        custom_instruction_block: answerInstructionBlocks.customInstructionBlock
          ? `${answerInstructionBlocks.customInstructionBlock}\n`
          : "",
        conversation_mode_instruction_block: answerInstructionBlocks.conversationModeInstructionBlock
          ? `${answerInstructionBlocks.conversationModeInstructionBlock}\n`
          : "",
        response_language_instruction: answerInstructionBlocks.responseLanguageInstruction,
        intent_topic: input.intentTopic || "not provided",
      }),
      prompt: renderPromptTemplate("retrieval/answer-user.md", {
        history_section: historySection || "No prior history",
        contexts_section: contextsSection || "No retrieved context",
        original_query: input.query,
        query: input.inScopeRequest ?? input.query,
        retrieval_query: input.retrievalQuery ?? input.query,
        outside_scope_request: input.outsideScopeRequest ?? "none",
      }),
      citations: input.contexts.map((context) => ({
        documentId: context.documentId,
        chunkId: context.chunkId,
        title: context.title,
      })),
    };
  }
}
