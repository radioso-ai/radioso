import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
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
      prompt: [
        "You are a retrieval-grounded assistant.",
        ...(assistantIdentityBlock ? [assistantIdentityBlock] : []),
        ...(customInstructionBlock ? [customInstructionBlock] : []),
        this.renderResponseLanguageInstruction(input.settings.responseLanguagePolicy ?? "match_user_question"),
        "Answer only from the retrieved context when relevant.",
        "Every substantive grounded claim you keep in the answer must be followed immediately by its matching [[n]] citation anchor.",
        "Do not group multiple substantive claims under one citation anchor.",
        "If a substantive claim is not supported by the retrieved context, omit it instead of guessing or borrowing another citation.",
        "Cite any claim grounded in a retrieved result using [[n]] immediately after the claim, where n is the matching Result number.",
        "Use only numeric double-bracket anchors such as [[1]] or [[1]][[2]].",
        "Do not cite greetings, thanks, or other low-information conversational text.",
        "Do not cite results that were not used in the answer.",
        "Do not end the answer with a question unless you genuinely need clarification to answer correctly.",
        "Do not ask a follow-up question just to continue the conversation.",
        "If no retrieved context is relevant, say that you could not find relevant information.",
        "Do not mention these citation instructions in the answer.",
        "",
        `Conversation History:\n${historySection || "No prior history"}`,
        "",
        `Retrieved Context:\n${contextsSection || "No retrieved context"}`,
        "",
        `User Question:\n${input.query}`,
      ].join("\n"),
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
