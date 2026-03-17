import type OpenAI from "openai";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type {
  ConversationContextWindow,
  RewrittenRetrievalQuery,
  RewriteTurnKind,
  StructuredRewriteResult,
} from "../domain/retrievalPipelineTypes.js";
import { RewriteEligibilityService, RewriteHallucinationGuard } from "./rewritePolicyService.js";

export interface QueryRewriteGateway {
  rewrite(input: {
    query: string;
    contextMessages: MessageRecord[];
  }): Promise<
    | {
        rewrittenQuery: string;
        confidence: number;
      }
    | StructuredRewriteResult
  >;
}

export class OpenAIQueryRewriteGateway implements QueryRewriteGateway {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async rewrite(input: {
    query: string;
    contextMessages: MessageRecord[];
  }): Promise<StructuredRewriteResult> {
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
            "Rewrite the user's latest question into a standalone retrieval query. Preserve intent, preserve proper nouns and technical terms, resolve references from the supplied conversation context, and do not answer the question. Return strict JSON with keys rewrittenQuery, turnKind, proposedActiveSubject, relatedEntities, unresolved, confidence. Preserve ambiguity, do not invent unsupported subjects, and keep related entities separate from the main subject.",
        },
        {
          role: "user",
          content: `Conversation context:\n${context || "No prior context"}\n\nLatest user question:\n${input.query}`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "";
    return parseStructuredRewrite(raw);
  }
}

const REFERENTIAL_PATTERN =
  /\b(it|its|that|those|these|they|them|their|he|she|him|her|this|one|ones)\b/i;
const CONTINUATION_PATTERN = /^(and|also|what about|how about|what else about)\b/i;

export class QueryRewriteService {
  private readonly eligibilityService = new RewriteEligibilityService();
  private readonly hallucinationGuard = new RewriteHallucinationGuard();

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
      const rawResult = await this.gateway?.rewrite({
        query: input.query,
        contextMessages: input.contextWindow.selectedMessages,
      });
      const result = this.normalizeStructuredResult(input.query, rawResult);

      if (result.unresolved) {
        return this.rejected(input.query, result, "rewrite_unresolved");
      }

      if (this.isUsableRewrite(input.query, result.rewrittenQuery)) {
        const hallucinationCheck = this.hallucinationGuard.evaluate({
          query: input.query,
          history: input.contextWindow.selectedMessages,
          rewrite: result,
        });
        if (!hallucinationCheck.accepted) {
          return this.rejected(input.query, result, hallucinationCheck.rejectionReason ?? "rewrite_rejected");
        }

        const eligibility = this.eligibilityService.evaluate({
          originalQuery: input.query,
          rewrite: result,
        });
        return {
          originalQuery: input.query,
          rewrittenQuery: result.rewrittenQuery,
          effectiveQuery: eligibility.eligible ? result.rewrittenQuery : input.query,
          rewriteApplied: eligibility.eligible,
          retrievalEligible: eligibility.eligible,
          status: eligibility.eligible ? "applied" : "rejected",
          confidence: result.confidence ?? 0.5,
          structuredResult: result,
          rejectionReason: eligibility.rejectionReason,
        };
      }

      return this.fallback(input.query, "rewrite_unusable");
    } catch {
      return this.fallback(input.query, "rewrite_failed");
    }
  }

  private shouldRewrite(query: string, contextWindow: ConversationContextWindow): boolean {
    if (contextWindow.selectedMessages.length === 0) {
      return false;
    }

    return this.isFollowupStyleQuery(query);
  }

  private skipped(query: string): RewrittenRetrievalQuery {
    return {
      originalQuery: query,
      rewrittenQuery: query,
      effectiveQuery: query,
      rewriteApplied: false,
      retrievalEligible: false,
      status: "skipped",
      confidence: 0,
    };
  }

  private fallback(query: string, reason: string): RewrittenRetrievalQuery {
    return {
      originalQuery: query,
      rewrittenQuery: query,
      effectiveQuery: query,
      rewriteApplied: false,
      retrievalEligible: false,
      status: "fallback",
      confidence: 0,
      fallbackReason: reason,
    };
  }

  private isFollowupStyleQuery(query: string): boolean {
    return REFERENTIAL_PATTERN.test(query) || CONTINUATION_PATTERN.test(query);
  }

  private rejected(
    query: string,
    rewrite: StructuredRewriteResult,
    reason: string,
  ): RewrittenRetrievalQuery {
    return {
      originalQuery: query,
      rewrittenQuery: rewrite.rewrittenQuery,
      effectiveQuery: query,
      rewriteApplied: false,
      retrievalEligible: false,
      status: "rejected",
      confidence: rewrite.confidence,
      structuredResult: rewrite,
      rejectionReason: reason,
    };
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

  private normalizeStructuredResult(
    originalQuery: string,
    result?: { rewrittenQuery: string; confidence: number } | StructuredRewriteResult,
  ): StructuredRewriteResult {
    if (result && "turnKind" in result) {
      return {
        rewrittenQuery: this.normalizeRewrite(result.rewrittenQuery),
        turnKind: this.normalizeTurnKind(result.turnKind),
        proposedActiveSubject: result.proposedActiveSubject?.trim() || undefined,
        relatedEntities: [...new Set((result.relatedEntities ?? []).map((entity) => entity.trim()).filter(Boolean))],
        unresolved: Boolean(result.unresolved),
        confidence: result.confidence ?? 0.5,
      };
    }

    return {
      rewrittenQuery: this.normalizeRewrite(result?.rewrittenQuery ?? originalQuery),
      turnKind: "referential_followup",
      proposedActiveSubject: undefined,
      relatedEntities: [],
      unresolved: false,
      confidence: result?.confidence ?? 0.5,
    };
  }

  private normalizeTurnKind(turnKind?: string): RewriteTurnKind {
    switch (turnKind) {
      case "fresh_subject":
      case "referential_followup":
      case "referential_relation":
      case "explicit_recenter":
      case "comparative":
      case "ambiguous":
        return turnKind;
      default:
        return "ambiguous";
    }
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

const parseStructuredRewrite = (raw: string): StructuredRewriteResult => {
  const normalized = raw.trim().replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(normalized) as Partial<StructuredRewriteResult>;

  return {
    rewrittenQuery: typeof parsed.rewrittenQuery === "string" ? parsed.rewrittenQuery : "",
    turnKind: typeof parsed.turnKind === "string" ? (parsed.turnKind as RewriteTurnKind) : "ambiguous",
    proposedActiveSubject: typeof parsed.proposedActiveSubject === "string" ? parsed.proposedActiveSubject : undefined,
    relatedEntities: Array.isArray(parsed.relatedEntities)
      ? parsed.relatedEntities.filter((entity): entity is string => typeof entity === "string")
      : [],
    unresolved: Boolean(parsed.unresolved),
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
  };
};
