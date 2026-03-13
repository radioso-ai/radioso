import type OpenAI from "openai";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ConversationContextWindow, RewrittenRetrievalQuery } from "../domain/retrievalPipelineTypes.js";

export interface QueryRewriteGateway {
  rewrite(input: {
    query: string;
    contextMessages: MessageRecord[];
  }): Promise<{ rewrittenQuery: string; confidence: number }>;
}

export class OpenAIQueryRewriteGateway implements QueryRewriteGateway {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async rewrite(input: {
    query: string;
    contextMessages: MessageRecord[];
  }): Promise<{ rewrittenQuery: string; confidence: number }> {
    const context = input.contextMessages
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n");

    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Rewrite the user's latest question into a standalone retrieval query. Preserve intent, preserve proper nouns and technical terms, resolve references from the supplied conversation context, and do not answer the question. Return only the rewritten query.",
        },
        {
          role: "user",
          content: `Conversation context:\n${context || "No prior context"}\n\nLatest user question:\n${input.query}`,
        },
      ],
    });

    return {
      rewrittenQuery: response.choices[0]?.message?.content?.trim() ?? "",
      confidence: 0.9,
    };
  }
}

const REFERENTIAL_PATTERN =
  /\b(it|its|that|those|these|they|them|their|he|she|him|her|this|one|ones)\b/i;

export class QueryRewriteService {
  constructor(private readonly gateway?: QueryRewriteGateway) {}

  async rewrite(input: {
    query: string;
    contextWindow: ConversationContextWindow;
    enabled: boolean;
  }): Promise<RewrittenRetrievalQuery> {
    if (!input.enabled) {
      return this.skipped(input.query);
    }

    if (!this.shouldRewrite(input.query, input.contextWindow)) {
      return this.skipped(input.query);
    }

    try {
      const result = await this.gateway?.rewrite({
        query: input.query,
        contextMessages: input.contextWindow.selectedMessages,
      });

      const rewrittenQuery = result?.rewrittenQuery.trim() ?? "";
      if (!rewrittenQuery || rewrittenQuery === input.query) {
        return this.skipped(input.query);
      }

      return {
        originalQuery: input.query,
        rewrittenQuery,
        effectiveQuery: rewrittenQuery,
        rewriteApplied: true,
        status: "applied",
        confidence: result?.confidence ?? 0.5,
      };
    } catch {
      return {
        originalQuery: input.query,
        rewrittenQuery: input.query,
        effectiveQuery: input.query,
        rewriteApplied: false,
        status: "fallback",
        confidence: 0,
        fallbackReason: "rewrite_failed",
      };
    }
  }

  private shouldRewrite(query: string, contextWindow: ConversationContextWindow): boolean {
    if (contextWindow.selectedMessages.length === 0) {
      return false;
    }

    return REFERENTIAL_PATTERN.test(query) || query.trim().split(/\s+/).length <= 6;
  }

  private skipped(query: string): RewrittenRetrievalQuery {
    return {
      originalQuery: query,
      rewrittenQuery: query,
      effectiveQuery: query,
      rewriteApplied: false,
      status: "skipped",
      confidence: 0,
    };
  }
}
