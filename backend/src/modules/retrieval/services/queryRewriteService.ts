import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
import type {
  ConversationContextWindow,
  RetrievalSubquery,
  RewrittenRetrievalQuery,
  ResponseLanguagePolicy,
  RewriteTurnKind,
  StructuredRewriteResult,
} from "../domain/retrievalPipelineTypes.js";
import { REWRITE_STATUS, REWRITE_TURN_KIND } from "../domain/retrievalPipelineTypes.js";
import { RewriteEligibilityService } from "./rewritePolicyService.js";

export interface QueryRewriteGatewayFallbackResult {
  rewrittenQuery: string;
  semanticQuery?: string;
  lexicalQuery?: string;
  confidence: number;
}

export type QueryRewriteGatewayResult = QueryRewriteGatewayFallbackResult | StructuredRewriteResult;

const QUERY_REWRITE_SYSTEM_PROMPT = `Rewrite the user's latest question for retrieval.
Preserve intent, preserve proper nouns and technical terms, resolve references only when supported by the supplied conversation context, and do not answer the question.
Preserve ambiguity instead of inventing certainty.
Keep related entities separate from the proposed main subject.
Preserve the response language policy. The final answer must stay in the same language as the current user question, even if retrieved documents are in another language.
Treat USER messages and the latest user question as authoritative grounding. ASSISTANT messages are context only, but concrete titles, names, or identifiers from the immediately preceding assistant turn may be copied into retrieval queries when they are needed for retrieval. Never claim the user explicitly said those literals.
Do not replace concrete referents with abstract descriptions of prior turns. Prefer concrete retrieval terms, or keep the original phrasing if no grounded rewrite is available.
Do not broaden the query into extra subtopics, checklists, or suggested facets that the user did not ask for.
Produce:
- semanticQuery: optimized for meaning-preserving semantic retrieval
- lexicalQuery: optimized for literal lexical retrieval using aliases, abbreviations, citation forms, or corpus-native notation when grounded
- responseLanguagePolicy: always "match_user_question"
- retrievalSubqueries: optional list of narrowly scoped retrieval lookups when the question should be searched in parts, such as distinct people or entities that need separate retrieval. Each subquery must preserve the same responseLanguagePolicy
- rewrittenQuery: a compatibility field that should mirror semanticQuery
Confidence means certainty in subject resolution and turn interpretation, not answer confidence:
- use 0.0-0.4 when ambiguity remains or the subject is only weakly implied
- use 0.5-0.7 when the likely subject is supported by user context but still inferential
- use 0.8-1.0 only when the current turn or explicit user context clearly supports the subject
Return strict JSON matching this blueprint exactly:
{"rewrittenQuery":"string","semanticQuery":"string","lexicalQuery":"string","responseLanguagePolicy":"match_user_question","retrievalSubqueries":[{"label":"string","semanticQuery":"string","lexicalQuery":"string","reason":"string|null","responseLanguagePolicy":"match_user_question"}],"turnKind":"fresh_subject|referential_followup|referential_relation|explicit_recenter|comparative|ambiguous","proposedActiveSubject":"string|null","relatedEntities":["string"],"unresolved":true,"confidence":0.0}
Do not wrap the JSON in markdown fences.`;

const DEFAULT_RESPONSE_LANGUAGE_POLICY: ResponseLanguagePolicy = "match_user_question";

export interface QueryRewriteGateway {
  rewrite(input: {
    query: string;
    contextMessages: MessageRecord[];
    carryForwardLiterals?: string[];
    semanticRewriteInstructions?: string;
    lexicalRewriteInstructions?: string;
  }): Promise<QueryRewriteGatewayResult>;
}

export class ModelQueryRewriteGateway implements QueryRewriteGateway {
  constructor(private readonly client: TextGenerationClient) {}

  async rewrite(input: {
    query: string;
    contextMessages: MessageRecord[];
    carryForwardLiterals?: string[];
    semanticRewriteInstructions?: string;
    lexicalRewriteInstructions?: string;
  }): Promise<StructuredRewriteResult> {
    const context = input.contextMessages
      .map((message) =>
        `${message.role.toUpperCase()}: ${message.content}${
          message.role === "user" ? " [authoritative for grounding]" : " [non-authoritative context]"
        }`,
      )
      .join("\n");

    const raw = await this.client.complete({
      systemPrompt: QUERY_REWRITE_SYSTEM_PROMPT,
      prompt: `Conversation context:\n${context || "No prior context"}${
        input.carryForwardLiterals && input.carryForwardLiterals.length > 0
          ? `\n\nGrounded carry-forward literals from the immediately previous assistant answer (for retrieval only, not as user-authored grounding):\n${JSON.stringify(input.carryForwardLiterals)}`
          : ""
      }\n\nSemantic rewrite instructions:\n${input.semanticRewriteInstructions ?? "Use the system default semantic rewrite behavior."}\n\nLexical rewrite instructions:\n${input.lexicalRewriteInstructions ?? "Use the system default lexical rewrite behavior."}\n\nLatest user question:\n${input.query}`,
    });

    return parseStructuredRewrite(raw);
  }
}

export class OpenAIQueryRewriteGateway implements QueryRewriteGateway {
  constructor(
    private readonly client: {
      chat: {
        completions: {
          create(input: {
            model: string;
            messages: Array<{ role: "system" | "user"; content: string }>;
          }): Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>;
        };
      };
    },
    private readonly model: string,
  ) {}

  async rewrite(input: {
    query: string;
    contextMessages: MessageRecord[];
    carryForwardLiterals?: string[];
    semanticRewriteInstructions?: string;
    lexicalRewriteInstructions?: string;
  }): Promise<StructuredRewriteResult> {
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
          }\n\nSemantic rewrite instructions:\n${input.semanticRewriteInstructions ?? "Use the system default semantic rewrite behavior."}\n\nLexical rewrite instructions:\n${input.lexicalRewriteInstructions ?? "Use the system default lexical rewrite behavior."}\n\nLatest user question:\n${input.query}`,
        },
      ],
    });

    const raw = response.choices?.[0]?.message?.content?.trim() ?? "";
    return parseStructuredRewrite(raw);
  }
}

export class QueryRewriteService {
  private readonly eligibilityService = new RewriteEligibilityService();

  constructor(private readonly gateway?: QueryRewriteGateway) {}

  async rewrite(input: {
    query: string;
    contextWindow: ConversationContextWindow;
    enabled: boolean;
    semanticRewriteInstructions?: string;
    lexicalRewriteInstructions?: string;
  }): Promise<RewrittenRetrievalQuery> {
    if (!input.enabled) {
      return this.skipped(input.query);
    }

    if (!this.shouldRewrite(input.contextWindow)) {
      return this.skipped(input.query);
    }

    try {
      const hasConversationContext = input.contextWindow.selectedMessages.length > 0;
      const rawResult = await this.gateway?.rewrite({
        query: input.query,
        contextMessages: input.contextWindow.selectedMessages,
        carryForwardLiterals: input.contextWindow.rewriteCarryForwardLiterals,
        semanticRewriteInstructions: input.semanticRewriteInstructions,
        lexicalRewriteInstructions: input.lexicalRewriteInstructions,
      });
      const result = this.normalizeStructuredResult(input.query, rawResult);
      const semanticQuery = this.selectSemanticQuery(
        input.query,
        result.semanticQuery ?? result.rewrittenQuery,
        hasConversationContext,
      );
      const lexicalQuery = this.selectLexicalQuery(
        input.query,
        result.lexicalQuery ?? result.rewrittenQuery,
        hasConversationContext,
      );
      const compatibilityRewrite = semanticQuery;
      const applied =
        semanticQuery !== input.query ||
        lexicalQuery !== input.query ||
        Boolean(result.retrievalSubqueries && result.retrievalSubqueries.length > 1);

      if (applied) {
        const eligibility = this.eligibilityService.evaluate({
          originalQuery: input.query,
          rewrite: {
            ...result,
            rewrittenQuery: compatibilityRewrite,
            semanticQuery,
            lexicalQuery,
          },
        });
        return {
          originalQuery: input.query,
          rewrittenQuery: compatibilityRewrite,
          effectiveQuery: eligibility.eligible ? semanticQuery : input.query,
          semanticQuery: eligibility.eligible ? semanticQuery : input.query,
          lexicalQuery: eligibility.eligible ? lexicalQuery : input.query,
          responseLanguagePolicy: result.responseLanguagePolicy ?? DEFAULT_RESPONSE_LANGUAGE_POLICY,
          retrievalSubqueries: eligibility.eligible ? result.retrievalSubqueries : undefined,
          rewriteApplied: eligibility.eligible,
          retrievalEligible: eligibility.eligible,
          status: eligibility.eligible ? REWRITE_STATUS.APPLIED : REWRITE_STATUS.REJECTED,
          confidence: result.confidence ?? 0.5,
          structuredResult: {
            ...result,
            rewrittenQuery: compatibilityRewrite,
            semanticQuery,
            lexicalQuery,
          },
          rejectionReason: eligibility.rejectionReason,
        };
      }

      return this.fallback(input.query, "rewrite_unusable");
    } catch {
      return this.fallback(input.query, "rewrite_failed");
    }
  }

  private shouldRewrite(contextWindow: ConversationContextWindow): boolean {
    return this.gateway !== undefined;
  }

  private skipped(query: string): RewrittenRetrievalQuery {
    return {
      originalQuery: query,
      rewrittenQuery: query,
      effectiveQuery: query,
      semanticQuery: query,
      lexicalQuery: query,
      responseLanguagePolicy: DEFAULT_RESPONSE_LANGUAGE_POLICY,
      retrievalSubqueries: undefined,
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
      semanticQuery: query,
      lexicalQuery: query,
      responseLanguagePolicy: DEFAULT_RESPONSE_LANGUAGE_POLICY,
      retrievalSubqueries: undefined,
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
      rewrittenQuery: rewrite.semanticQuery ?? rewrite.rewrittenQuery,
      effectiveQuery: query,
      semanticQuery: query,
      lexicalQuery: query,
      responseLanguagePolicy: rewrite.responseLanguagePolicy ?? DEFAULT_RESPONSE_LANGUAGE_POLICY,
      retrievalSubqueries: rewrite.retrievalSubqueries,
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
        semanticQuery: this.normalizeRewrite(result.semanticQuery ?? result.rewrittenQuery),
        lexicalQuery: this.normalizeRewrite(result.lexicalQuery ?? result.rewrittenQuery),
        responseLanguagePolicy: this.normalizeResponseLanguagePolicy(result.responseLanguagePolicy),
        retrievalSubqueries: this.normalizeRetrievalSubqueries(result.retrievalSubqueries),
        turnKind: this.normalizeTurnKind(result.turnKind),
        proposedActiveSubject: result.proposedActiveSubject?.trim() || undefined,
        relatedEntities: [...new Set((result.relatedEntities ?? []).map((entity) => entity.trim()).filter(Boolean))],
        unresolved: Boolean(result.unresolved),
        confidence: result.confidence ?? 0.5,
      };
    }

    return {
      rewrittenQuery: this.normalizeRewrite(result?.rewrittenQuery ?? originalQuery),
      semanticQuery: this.normalizeRewrite(result?.semanticQuery ?? result?.rewrittenQuery ?? originalQuery),
      lexicalQuery: this.normalizeRewrite(result?.lexicalQuery ?? result?.rewrittenQuery ?? originalQuery),
      responseLanguagePolicy: DEFAULT_RESPONSE_LANGUAGE_POLICY,
      retrievalSubqueries: undefined,
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

  private normalizeRetrievalSubqueries(retrievalSubqueries?: RetrievalSubquery[]): RetrievalSubquery[] | undefined {
    if (!Array.isArray(retrievalSubqueries)) {
      return undefined;
    }

    const normalized = retrievalSubqueries
      .map((subquery, index) => {
        const label = this.normalizeRewrite(subquery?.label);
        const semanticQuery = this.normalizeRewrite(subquery?.semanticQuery);
        const lexicalQuery = this.normalizeRewrite(subquery?.lexicalQuery ?? semanticQuery);
        if (!label || !semanticQuery || !lexicalQuery) {
          return null;
        }

        return {
          id: `subquery_${index + 1}`,
          label,
          semanticQuery,
          lexicalQuery,
          reason: this.normalizeOptionalRewrite(subquery?.reason),
          responseLanguagePolicy: this.normalizeResponseLanguagePolicy(subquery?.responseLanguagePolicy),
        };
      })
      .filter((subquery): subquery is NonNullable<typeof subquery> => subquery !== null)
      .slice(0, 4);

    return normalized.length > 1 ? normalized : undefined;
  }

  private normalizeOptionalRewrite(rewrittenQuery?: string): string | undefined {
    const normalized = this.normalizeRewrite(rewrittenQuery);
    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizeResponseLanguagePolicy(value?: string): ResponseLanguagePolicy {
    return value === "match_user_question" ? value : DEFAULT_RESPONSE_LANGUAGE_POLICY;
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

  private selectUsableQuery(originalQuery: string, candidateQuery: string): string {
    return this.isUsableRewrite(originalQuery, candidateQuery) ? candidateQuery : originalQuery;
  }

  private selectSemanticQuery(originalQuery: string, candidateQuery: string, hasConversationContext: boolean): string {
    const selected = this.selectUsableQuery(originalQuery, candidateQuery);
    if (selected === originalQuery) {
      return originalQuery;
    }

    if (!hasConversationContext && this.introducesExcessiveTermDrift(originalQuery, selected)) {
      return originalQuery;
    }

    return selected;
  }

  private selectLexicalQuery(originalQuery: string, candidateQuery: string, hasConversationContext: boolean): string {
    const selected = this.selectUsableQuery(originalQuery, candidateQuery);
    if (selected === originalQuery) {
      return originalQuery;
    }

    if (!hasConversationContext) {
      return originalQuery;
    }

    return selected;
  }

  private introducesExcessiveTermDrift(originalQuery: string, candidateQuery: string): boolean {
    return this.countNewTerms(originalQuery, candidateQuery) > 2;
  }

  private countNewTerms(originalQuery: string, candidateQuery: string): number {
    const originalTerms = new Set(tokenizeRewriteTerms(originalQuery));
    const candidateTerms = tokenizeRewriteTerms(candidateQuery);

    return candidateTerms.filter((term) => !originalTerms.has(term)).length;
  }
}

const tokenizeRewriteTerms = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);

const parseStructuredRewrite = (raw: string): StructuredRewriteResult => {
  const normalized = raw.trim().replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(normalized) as Partial<StructuredRewriteResult>;
  const parsedSubqueries = Array.isArray(parsed.retrievalSubqueries)
    ? parsed.retrievalSubqueries
        .filter((entry) => Boolean(entry) && typeof entry === "object")
        .map((entry) => ({
          id: "",
          label: typeof (entry as { label?: unknown }).label === "string" ? (entry as { label: string }).label : "",
          semanticQuery:
            typeof (entry as { semanticQuery?: unknown }).semanticQuery === "string"
              ? (entry as { semanticQuery: string }).semanticQuery
              : "",
          lexicalQuery:
            typeof (entry as { lexicalQuery?: unknown }).lexicalQuery === "string"
              ? (entry as { lexicalQuery: string }).lexicalQuery
              : typeof (entry as { semanticQuery?: unknown }).semanticQuery === "string"
                ? (entry as { semanticQuery: string }).semanticQuery
                : "",
          reason: typeof (entry as { reason?: unknown }).reason === "string" ? (entry as { reason: string }).reason : undefined,
          responseLanguagePolicy:
            typeof (entry as { responseLanguagePolicy?: unknown }).responseLanguagePolicy === "string" &&
            (entry as { responseLanguagePolicy: string }).responseLanguagePolicy === "match_user_question"
              ? "match_user_question"
              : DEFAULT_RESPONSE_LANGUAGE_POLICY,
        }))
    : undefined;

  return {
    rewrittenQuery: typeof parsed.rewrittenQuery === "string" ? parsed.rewrittenQuery : "",
    semanticQuery:
      typeof parsed.semanticQuery === "string"
        ? parsed.semanticQuery
        : typeof parsed.rewrittenQuery === "string"
          ? parsed.rewrittenQuery
          : "",
    lexicalQuery:
      typeof parsed.lexicalQuery === "string"
        ? parsed.lexicalQuery
        : typeof parsed.rewrittenQuery === "string"
          ? parsed.rewrittenQuery
          : "",
    responseLanguagePolicy:
      typeof parsed.responseLanguagePolicy === "string" && parsed.responseLanguagePolicy === "match_user_question"
        ? parsed.responseLanguagePolicy
        : DEFAULT_RESPONSE_LANGUAGE_POLICY,
    retrievalSubqueries: parsedSubqueries,
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
