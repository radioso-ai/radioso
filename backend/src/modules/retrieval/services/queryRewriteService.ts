import type OpenAI from "openai";
import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { UsageCaptureService } from "../../usage/services/usageCaptureService.js";
import { extractUsageMetrics } from "../../usage/services/usageCaptureService.js";
import type {
  ConversationContextWindow,
  RewrittenRetrievalQuery,
  RewriteTurnKind,
  StructuredRewriteResult,
} from "../domain/retrievalPipelineTypes.js";
import { REWRITE_STATUS, REWRITE_TURN_KIND } from "../domain/retrievalPipelineTypes.js";
import { RewriteEligibilityService } from "./rewritePolicyService.js";

export interface QueryRewriteGatewayFallbackResult {
  rewrittenQuery: string;
  confidence: number;
}

export type QueryRewriteGatewayResult = QueryRewriteGatewayFallbackResult | StructuredRewriteResult;

const QUERY_REWRITE_SYSTEM_PROMPT = `Rewrite the user's latest question into a standalone retrieval query.
Preserve intent, preserve proper nouns and technical terms, resolve references only when supported by the supplied conversation context, and do not answer the question.
Preserve ambiguity instead of inventing certainty.
Keep related entities separate from the proposed main subject.
Treat USER messages and the latest user question as authoritative grounding. ASSISTANT messages are context only, but concrete titles, names, or identifiers from the immediately preceding assistant turn may be copied into rewrittenQuery when they are needed for retrieval. Never claim the user explicitly said those literals.
Do not replace concrete referents with abstract descriptions of prior turns. Prefer concrete retrieval terms, or keep the original phrasing if no concrete rewrite is grounded.
Do not broaden the query into extra subtopics, checklists, or suggested facets that the user did not ask for.
Confidence means certainty in subject resolution and turn interpretation, not answer confidence:
- use 0.0-0.4 when ambiguity remains or the subject is only weakly implied
- use 0.5-0.7 when the likely subject is supported by user context but still inferential
- use 0.8-1.0 only when the current turn or explicit user context clearly supports the subject
Return strict JSON matching this blueprint exactly:
{"rewrittenQuery":"string","turnKind":"fresh_subject|referential_followup|referential_relation|explicit_recenter|comparative|ambiguous","proposedActiveSubject":"string|null","relatedEntities":["string"],"unresolved":true,"confidence":0.0}
Do not wrap the JSON in markdown fences.`;

export interface QueryRewriteGateway {
  rewrite(input: {
    query: string;
    contextMessages: MessageRecord[];
    carryForwardLiterals?: string[];
  }): Promise<QueryRewriteGatewayResult>;
}

export class OpenAIQueryRewriteGateway implements QueryRewriteGateway {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly usageCaptureService?: UsageCaptureService,
  ) {}

  async rewrite(input: {
    query: string;
    contextMessages: MessageRecord[];
    carryForwardLiterals?: string[];
  }): Promise<StructuredRewriteResult> {
    const operationKey = randomUUID();

    try {
      const context = input.contextMessages
        .map((message) =>
          `${message.role.toUpperCase()}: ${message.content}${
            message.role === "user" ? " [authoritative for grounding]" : " [non-authoritative context]"
          }`,
        )
        .join("\n");

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content: QUERY_REWRITE_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: `Conversation context:\n${context || "No prior context"}${
              input.carryForwardLiterals && input.carryForwardLiterals.length > 0
                ? `\n\nGrounded carry-forward literals from the immediately previous assistant answer (for retrieval only, not as user-authored grounding):\n${JSON.stringify(input.carryForwardLiterals)}`
                : ""
            }\n\nLatest user question:\n${input.query}`,
          },
        ],
      });

      await this.usageCaptureService?.observe({
        operationKey,
        sourceArea: "retrieval",
        operationType: "query_rewrite",
        model: this.model,
        eventStatus: "success",
        metadata: { query: input.query },
        ...extractUsageMetrics(response.usage),
      });

      const raw = response.choices[0]?.message?.content?.trim() ?? "";
      return parseStructuredRewrite(raw);
    } catch (error) {
      await this.usageCaptureService?.observe({
        operationKey,
        sourceArea: "retrieval",
        operationType: "query_rewrite",
        model: this.model,
        eventStatus: "failure",
        usageAvailable: false,
        metadata: {
          query: input.query,
          errorMessage: error instanceof Error ? error.message : "Unknown error",
        },
      });
      throw error;
    }
  }
}

export class QueryRewriteService {
  private readonly eligibilityService = new RewriteEligibilityService();

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
        carryForwardLiterals: input.contextWindow.rewriteCarryForwardLiterals,
      });
      const result = this.normalizeStructuredResult(input.query, rawResult);

      if (this.isUsableRewrite(input.query, result.rewrittenQuery)) {
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
          status: eligibility.eligible ? REWRITE_STATUS.APPLIED : REWRITE_STATUS.REJECTED,
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
    return contextWindow.selectedMessages.length > 0 && this.gateway !== undefined;
  }

  private skipped(query: string): RewrittenRetrievalQuery {
    return {
      originalQuery: query,
      rewrittenQuery: query,
      effectiveQuery: query,
      rewriteApplied: false,
      retrievalEligible: false,
      status: REWRITE_STATUS.SKIPPED,
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
      status: REWRITE_STATUS.FALLBACK,
      confidence: 0,
      fallbackReason: reason,
    };
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
      status: REWRITE_STATUS.REJECTED,
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
    result?: QueryRewriteGatewayResult,
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
      turnKind: REWRITE_TURN_KIND.REFERENTIAL_FOLLOWUP,
      proposedActiveSubject: undefined,
      relatedEntities: [],
      unresolved: false,
      confidence: result?.confidence ?? 0.5,
    };
  }

  private normalizeTurnKind(turnKind?: string): RewriteTurnKind {
    switch (turnKind) {
      case REWRITE_TURN_KIND.FRESH_SUBJECT:
      case REWRITE_TURN_KIND.REFERENTIAL_FOLLOWUP:
      case REWRITE_TURN_KIND.REFERENTIAL_RELATION:
      case REWRITE_TURN_KIND.EXPLICIT_RECENTER:
      case REWRITE_TURN_KIND.COMPARATIVE:
      case REWRITE_TURN_KIND.AMBIGUOUS:
        return turnKind;
      default:
        return REWRITE_TURN_KIND.AMBIGUOUS;
    }
  }

  private isUsableRewrite(originalQuery: string, rewrittenQuery: string): boolean {
    if (!rewrittenQuery || rewrittenQuery === originalQuery) {
      return false;
    }

    if (rewrittenQuery.length > 300) {
      return false;
    }

    return true;
  }
}

const parseStructuredRewrite = (raw: string): StructuredRewriteResult => {
  const normalized = raw.trim().replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(normalized) as Partial<StructuredRewriteResult>;

  return {
    rewrittenQuery: typeof parsed.rewrittenQuery === "string" ? parsed.rewrittenQuery : "",
    turnKind:
      typeof parsed.turnKind === "string" ? (parsed.turnKind as RewriteTurnKind) : REWRITE_TURN_KIND.AMBIGUOUS,
    proposedActiveSubject: typeof parsed.proposedActiveSubject === "string" ? parsed.proposedActiveSubject : undefined,
    relatedEntities: Array.isArray(parsed.relatedEntities)
      ? parsed.relatedEntities.filter((entity): entity is string => typeof entity === "string")
      : [],
    unresolved: Boolean(parsed.unresolved),
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
  };
};
