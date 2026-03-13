import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { FinalPromptContext } from "../domain/retrievalPipelineTypes.js";

export interface PromptBuildResult {
  prompt: string;
  citations: Array<{ documentId: string; chunkId: string; title: string }>;
}

export class PromptBuilder {
  build(input: { query: string; history: MessageRecord[]; contexts: FinalPromptContext[] }): PromptBuildResult {
    const historySection = input.history
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n");
    const contextsSection = input.contexts
      .map((context, index) => `Context ${index + 1} (${context.title}): ${context.content}`)
      .join("\n\n");

    return {
      prompt: `You are a retrieval-grounded assistant.\n\nConversation History:\n${historySection || "No prior history"}\n\nRetrieved Context:\n${contextsSection || "No retrieved context"}\n\nUser Question:\n${input.query}`,
      citations: input.contexts.map((context) => ({
        documentId: context.documentId,
        chunkId: context.chunkId,
        title: context.title,
      })),
    };
  }
}
