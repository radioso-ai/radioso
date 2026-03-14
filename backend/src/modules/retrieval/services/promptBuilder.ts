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
        return `Context ${index + 1} (${context.title}): ${prefix}${context.content}`;
      })
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
      return `Use a terse, direct tone, short answers to the point, don't suggest any help.  Warmth:${warmthLevel} out of 10`;
    }

    if (warmthLevel <= 7) {
      return `Use a clear, natural, moderately warm tone. Warmth:${warmthLevel} out of 10`;
    }

    return `Use a warm, considerate tone. Acknowledge the user's questions. Warmth:${warmthLevel} out of 10`;
  }
}
