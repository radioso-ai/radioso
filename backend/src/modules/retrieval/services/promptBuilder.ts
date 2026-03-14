import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { FinalPromptContext } from "../domain/retrievalPipelineTypes.js";

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
    };
  }): PromptBuildResult {
    const historySection = input.history
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n");
    const contextsSection = input.contexts
      .map((context, index) => `Context ${index + 1} (${context.title}): ${context.content}`)
      .join("\n\n");
    const warmthInstruction = this.getWarmthInstruction(input.settings.warmthLevel);

    return {
      prompt: [
        "You are a retrieval-grounded assistant.",
        warmthInstruction,
        "Answer only from the retrieved context when relevant.",
        "Do not end the answer with a question unless you genuinely need clarification to answer correctly.",
        "Do not ask a follow-up question just to continue the conversation.",
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
      return `Use a terse, direct tone. Warmth:${warmthLevel}`;
    }

    if (warmthLevel <= 7) {
      return `Use a clear, natural, moderately warm tone. Warmth:${warmthLevel}`;
    }

    return `Use a warm, considerate tone while staying concise and grounded. Warmth:${warmthLevel}`;
  }
}
