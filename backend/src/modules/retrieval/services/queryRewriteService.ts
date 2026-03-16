import type OpenAI from "openai";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ConversationContextWindow, RewrittenRetrievalQuery, SubjectReference } from "../domain/retrievalPipelineTypes.js";

export interface QueryRewriteGateway {
  rewrite(input: {
    query: string;
    contextMessages: MessageRecord[];
    carriedSubject?: SubjectReference | null;
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
    carriedSubject?: SubjectReference | null;
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
          content: `Conversation context:\n${context || "No prior context"}\n\nCarried subject:\n${input.carriedSubject?.canonicalLabel ?? "None"}\n\nLatest user question:\n${input.query}`,
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
const CONTINUATION_PATTERN = /^(and|also|what about|how about|what else about)\b/i;

export class QueryRewriteService {
  constructor(private readonly gateway?: QueryRewriteGateway) {}

  async rewrite(input: {
    query: string;
    contextWindow: ConversationContextWindow;
    enabled: boolean;
    carriedSubject?: SubjectReference | null;
    selfContained?: boolean;
  }): Promise<RewrittenRetrievalQuery> {
    if (!input.enabled) {
      return this.skipped(input.query);
    }

    if (!this.shouldRewrite(input.query, input.contextWindow, input.carriedSubject, input.selfContained)) {
      return this.skipped(input.query);
    }

    try {
      const result = await this.gateway?.rewrite({
        query: input.query,
        contextMessages: input.contextWindow.selectedMessages,
        carriedSubject: input.carriedSubject,
      });

      const rewrittenQuery = this.normalizeRewrite(result?.rewrittenQuery);
      if (this.isUsableRewrite(input.query, rewrittenQuery)) {
        return {
          originalQuery: input.query,
          rewrittenQuery,
          effectiveQuery: rewrittenQuery,
          rewriteApplied: true,
          status: "applied",
          confidence: result?.confidence ?? 0.5,
          usedCarriedSubject: Boolean(input.carriedSubject),
        };
      }

      return this.heuristicFallback(input.query, input.contextWindow, "rewrite_unusable", input.carriedSubject, input.selfContained);
    } catch {
      return this.heuristicFallback(input.query, input.contextWindow, "rewrite_failed", input.carriedSubject, input.selfContained);
    }
  }

  private shouldRewrite(
    query: string,
    contextWindow: ConversationContextWindow,
    carriedSubject?: SubjectReference | null,
    selfContained?: boolean,
  ): boolean {
    if (contextWindow.selectedMessages.length === 0) {
      return Boolean(carriedSubject) && selfContained === false;
    }

    return Boolean(carriedSubject && selfContained === false) || this.isFollowupStyleQuery(query);
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

  private heuristicFallback(
    query: string,
    contextWindow: ConversationContextWindow,
    reason: string,
    carriedSubject?: SubjectReference | null,
    selfContained?: boolean,
  ): RewrittenRetrievalQuery {
    if (!this.isFollowupStyleQuery(query) && !(carriedSubject && selfContained === false)) {
      return {
        originalQuery: query,
        rewrittenQuery: query,
        effectiveQuery: query,
        rewriteApplied: false,
        status: "fallback",
        confidence: 0,
        fallbackReason: reason,
      };
    }

    const heuristicRewrite = this.buildHeuristicRewrite(query, contextWindow, carriedSubject);
    if (!heuristicRewrite || heuristicRewrite === query) {
      return {
        originalQuery: query,
        rewrittenQuery: query,
        effectiveQuery: query,
        rewriteApplied: false,
        status: "fallback",
        confidence: 0,
        fallbackReason: reason,
      };
    }

    return {
      originalQuery: query,
      rewrittenQuery: heuristicRewrite,
      effectiveQuery: heuristicRewrite,
      rewriteApplied: true,
      status: "fallback",
      confidence: 0.25,
      fallbackReason: reason,
      usedCarriedSubject: Boolean(carriedSubject),
    };
  }

  private isFollowupStyleQuery(query: string): boolean {
    return REFERENTIAL_PATTERN.test(query) || CONTINUATION_PATTERN.test(query);
  }

  private buildHeuristicRewrite(
    query: string,
    contextWindow: ConversationContextWindow,
    carriedSubject?: SubjectReference | null,
  ): string | null {
    const contextSubject = carriedSubject?.canonicalLabel ?? this.extractContextSubject(contextWindow.selectedMessages);
    if (!contextSubject) {
      return null;
    }

    if (REFERENTIAL_PATTERN.test(query) || carriedSubject) {
      return this.replaceReferentialSubject(query, contextSubject);
    }

    return `${contextSubject} ${query}`.trim();
  }

  private extractContextSubject(messages: MessageRecord[]): string | null {
    const recentUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user" && message.content.trim().length > 0)?.content;

    if (!recentUserMessage) {
      return null;
    }

    const normalized = recentUserMessage
      .trim()
      .replace(/^tell me about\s+/i, "")
      .replace(/^what is\s+/i, "")
      .replace(/^explain\s+/i, "")
      .replace(/^describe\s+/i, "")
      .replace(/^can you explain\s+/i, "")
      .replace(/[?.!]+$/g, "")
      .trim();

    return normalized.length > 0 ? normalized : null;
  }

  private replaceReferentialSubject(query: string, subject: string): string {
    const loweredSubject = subject.replace(/^(the|a|an)\s+/i, "").trim();

    return query
      .replace(/\bit\b/i, `the ${loweredSubject}`)
      .replace(/\bits\b/i, `${loweredSubject}'s`)
      .replace(/\bthis\b/i, `the ${loweredSubject}`)
      .replace(/\bthat\b/i, `the ${loweredSubject}`)
      .replace(/\bhe\b/i, loweredSubject)
      .replace(/\bshe\b/i, loweredSubject)
      .replace(/\bhim\b/i, loweredSubject)
      .replace(/\bher\b(?=\s+[\p{L}\p{N}])/iu, `${loweredSubject}'s`)
      .replace(/\bher\b/i, loweredSubject)
      .replace(/\bthey\b/i, loweredSubject)
      .replace(/\bthem\b/i, loweredSubject)
      .replace(/\btheir\b/i, `${loweredSubject}'s`)
      .replace(/\s+/g, " ")
      .trim();
  }

  private normalizeRewrite(rewrittenQuery?: string): string {
    return (rewrittenQuery ?? "")
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .replace(/^rewritten query:\s*/i, "")
      .replace(/^query:\s*/i, "")
      .replace(/^["']|["']$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private isUsableRewrite(originalQuery: string, rewrittenQuery: string): boolean {
    if (!rewrittenQuery || rewrittenQuery === originalQuery) {
      return false;
    }

    if (rewrittenQuery.length > 300) {
      return false;
    }

    return !/^(answer|the answer is|here('| i)?s)/i.test(rewrittenQuery);
  }
}
