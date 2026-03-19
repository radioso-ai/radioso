import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { FinalPromptContext } from "../domain/retrievalPipelineTypes.js";
import { renderStructuredAttributeSummary } from "../domain/structuredAttributes.js";

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
      warmthLevel: number;
      customInstruction?: string;
    };
  }): PromptBuildResult {
    const historySection = input.history
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n");
    const contextsSection = input.contexts
      .map((context, index) => {
        const attributeSummary = renderStructuredAttributeSummary(context.structuredAttributes ?? {
          datePoints: [],
          dateRanges: [],
          moneyValues: [],
          locations: [],
        });
        const prefix = attributeSummary ? `Attributes: ${attributeSummary}\n` : "";
        // Currently renders sourceUrl; extend as more metadata keys become prompt-relevant.
        // Sanitize to prevent prompt injection via newlines or control characters.
        const rawSourceUrl = typeof context.metadata?.sourceUrl === "string" ? context.metadata.sourceUrl : "";
        const sanitizedSourceUrl = rawSourceUrl.replace(/[\n\r\t\x00-\x1f]/g, "").slice(0, 2048);
        const metadataLine = sanitizedSourceUrl ? `Source: ${sanitizedSourceUrl}\n` : "";
        return `Result ${index + 1} (${context.title}): ${prefix}${metadataLine}${context.content}`;
      })
      .join("\n\n");
    const warmthInstruction = this.getWarmthInstruction(input.settings.warmthLevel);
    const customInstructionBlock = this.renderCustomInstruction(input.settings.customInstruction);

    return {
      prompt: [
        "You are a retrieval-grounded assistant.",
        warmthInstruction,
        ...(customInstructionBlock ? [customInstructionBlock] : []),
        "Answer only from the retrieved context when relevant.",
        "Cite any claim grounded in a retrieved result using [[n]] immediately after the claim, where n is the matching Result number.",
        "Use only numeric double-bracket anchors such as [[1]] or [[1]][[2]].",
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

  private getWarmthInstruction(warmthLevel: number): string {
    if (warmthLevel <= 3) {
      return `Use a terse, direct tone, short answers to the point, don't suggest any help.  Warmth:${warmthLevel} out of 10`;
    }

    if (warmthLevel <= 7) {
      return `Use a clear, natural, moderately warm tone. Warmth:${warmthLevel} out of 10`;
    }

    return `Use a warm, considerate tone. Acknowledge the user's questions. Warmth:${warmthLevel} out of 10`;
  }

  private renderCustomInstruction(customInstruction?: string): string | null {
    if (!customInstruction) return null;
    const sanitized = customInstruction.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    if (!sanitized.trim()) return null;
    return `Workspace-specific instructions:\n${sanitized}`;
  }
}
