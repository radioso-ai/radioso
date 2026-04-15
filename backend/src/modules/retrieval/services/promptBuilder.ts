import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { AssistantIdentityPromptInput } from "../../settings/domain/assistantBootstrapSettings.js";
import type { FinalPromptContext, ResponseLanguagePolicy } from "../domain/retrievalPipelineTypes.js";

export interface PromptBuildResult {
  prompt: string;
  citations: Array<{ documentId: string; chunkId: string; title: string }>;
}

export class PromptBuilder {
  build(input: {
    query: string;
    history: MessageRecord[];
    contexts: FinalPromptContext[];
    settings: {
      assistantIdentity?: AssistantIdentityPromptInput | null;
      customInstruction?: string;
      responseLanguagePolicy?: ResponseLanguagePolicy;
    };
  }): PromptBuildResult {
    const historySection = input.history
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n");
    const contextsSection = input.contexts
      .map((context, index) => {
        // Currently renders sourceUrl; extend as more metadata keys become prompt-relevant.
        // Sanitize to prevent prompt injection via newlines or control characters.
        const rawSourceUrl = typeof context.metadata?.sourceUrl === "string" ? context.metadata.sourceUrl : "";
        const sanitizedSourceUrl = rawSourceUrl.replace(/[\n\r\t\x00-\x1f]/g, "").slice(0, 2048);
        const metadataLine = sanitizedSourceUrl ? `Source: ${sanitizedSourceUrl}\n` : "";
        return `Result ${index + 1} (${context.title}): ${metadataLine}${context.content}`;
      })
      .join("\n\n");
    const customInstructionBlock = this.renderCustomInstruction(input.settings.customInstruction);
    const assistantIdentityBlock = this.renderAssistantIdentity(input.settings.assistantIdentity);

    return {
      prompt: renderPromptTemplate("retrieval/answer.md", {
        assistant_identity_block: assistantIdentityBlock ? `${assistantIdentityBlock}\n` : "",
        custom_instruction_block: customInstructionBlock ? `${customInstructionBlock}\n` : "",
        response_language_instruction: this.renderResponseLanguageInstruction(
          input.settings.responseLanguagePolicy ?? "match_user_question",
        ),
        history_section: historySection || "No prior history",
        contexts_section: contextsSection || "No retrieved context",
        query: input.query,
      }),
      citations: input.contexts.map((context) => ({
        documentId: context.documentId,
        chunkId: context.chunkId,
        title: context.title,
      })),
    };
  }

  private renderCustomInstruction(customInstruction?: string): string | null {
    if (!customInstruction) return null;
    const sanitized = customInstruction.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    if (!sanitized.trim()) return null;
    return `Workspace-specific instructions:\n${sanitized}`;
  }

  private renderAssistantIdentity(assistantIdentity?: AssistantIdentityPromptInput | null): string | null {
    if (!assistantIdentity) {
      return null;
    }

    const identityLines = [
      assistantIdentity.assistantName ? `Assistant name: ${assistantIdentity.assistantName}` : null,
      assistantIdentity.assistantRole ? `Assistant role: ${assistantIdentity.assistantRole}` : null,
      assistantIdentity.greetingInstruction ? `Assistant style: ${assistantIdentity.greetingInstruction}` : null,
    ].filter(Boolean);

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
