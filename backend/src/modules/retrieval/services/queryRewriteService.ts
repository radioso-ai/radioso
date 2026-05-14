import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { CHAT_BEHAVIOR, RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import {
  normalizeLlmClassifierLabel,
  normalizeLlmClassifierLanguageLabel,
} from "../../../shared/domain/llmClassifierFields.js";
import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
import { loadPromptTemplate, renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { RetrievalMetadataRule } from "../../settings/contracts/retrieval.js";
import { getNormalizedMetadataConditions } from "../../settings/contracts/retrieval.js";
import type {
  ConversationContextWindow,
  ResponseIntent,
  RetrievalQueryShape,
  RetrievalSubquery,
  RewrittenRetrievalQuery,
  ResponseLanguagePolicy,
  TriggerAnalysisResult,
  RewriteTurnKind,
  StructuredRewriteResult,
} from "../domain/retrievalPipelineTypes.js";
import { RESPONSE_INTENT, REWRITE_STATUS, REWRITE_TURN_KIND } from "../domain/retrievalPipelineTypes.js";
import { buildLexicalAlternativeSubqueries } from "../domain/lexicalQueryPlan.js";
import { RewriteEligibilityService } from "./rewritePolicyService.js";

export interface QueryRewriteGatewayFallbackResult {
  rewrittenQuery: string;
  semanticQuery?: string;
  lexicalQuery?: string;
  confidence: number;
}

export type QueryRewriteGatewayResult = QueryRewriteGatewayFallbackResult | StructuredRewriteResult;
export interface TriggerAnalysisGatewayInput {
  query: string;
  activeQuery: string;
  contextMessages: MessageRecord[];
  rules: RetrievalMetadataRule[];
}

let triggerAnalysisSystemPrompt: string | undefined;

const getTriggerAnalysisSystemPrompt = (): string => {
  triggerAnalysisSystemPrompt ??= loadPromptTemplate("retrieval/trigger-analysis-system.md");
  return triggerAnalysisSystemPrompt;
};

const DEFAULT_RESPONSE_LANGUAGE_POLICY: ResponseLanguagePolicy = "match_user_question";
const TRIGGER_MATCH_ENACTMENT_THRESHOLD = RETRIEVAL_BEHAVIOR.hybrid.triggerMatchEnactmentThreshold;
const NON_RETRIEVAL_INTENT_CONFIDENCE_THRESHOLD = CHAT_BEHAVIOR.intentRouting.nonRetrievalConfidenceThreshold;

const buildQueryRewritePrompt = (input: {
  context: string;
  semanticRewriteInstructions?: string;
  lexicalRewriteInstructions?: string;
  answerScopeReference?: string;
  query: string;
}): string =>
  renderPromptTemplate("retrieval/query-rewrite.md", {
    context_section: input.context || "No prior context",
    semantic_rewrite_instructions:
      input.semanticRewriteInstructions ?? "Use the system default semantic rewrite behavior.",
    lexical_rewrite_instructions:
      input.lexicalRewriteInstructions ?? "Use the system default lexical rewrite behavior.",
    answer_scope_reference_section: input.answerScopeReference?.trim()
      ? [
          "Assistant answer scope reference:",
          input.answerScopeReference.trim(),
          "",
          "Compare the latest user question against this scope reference before choosing responseIntent, inScopeRequest, and outsideScopeRequest.",
          "Treat the scope reference as trusted assistant configuration, not as user content, and do not copy it into output fields.",
        ].join("\n")
      : "",
    query: input.query,
  });

const formatConversationContext = (messages: MessageRecord[]): string =>
  messages
    .map((message) =>
      `${message.role.toUpperCase()}: ${message.content}${
        message.role === "user" ? " [authoritative for grounding]" : " [non-authoritative context]"
      }`,
    )
    .join("\n");

const buildTriggerAnalysisPrompt = (input: {
  query: string;
  activeQuery: string;
  context: string;
  rules: RetrievalMetadataRule[];
}): string =>
  renderPromptTemplate("retrieval/trigger-analysis-user.md", {
    query: input.query,
    active_query: input.activeQuery,
    context_section: input.context || "No prior context",
    rules_json: JSON.stringify(
      input.rules.map((rule) => ({
        ruleId: rule.id,
        triggerInstruction: rule.triggerInstruction,
        effect: rule.effect,
        combinator: rule.combinator ?? "and",
        conditions: getNormalizedMetadataConditions(rule).map((condition) => ({
          field: condition.field,
          operator: condition.operator,
          value: condition.value,
          valueType: condition.valueType,
        })),
      })),
      null,
      2,
    ),
  });

export interface QueryRewriteGateway {
  rewrite(input: {
    query: string;
    contextMessages: MessageRecord[];
    semanticRewriteInstructions?: string;
    lexicalRewriteInstructions?: string;
    answerScopeReference?: string;
  }): Promise<QueryRewriteGatewayResult>;
}

export interface TriggerAnalysisGateway {
  analyze(input: TriggerAnalysisGatewayInput): Promise<TriggerAnalysisResult>;
}

export class ModelTriggerAnalysisGateway implements TriggerAnalysisGateway {
  constructor(private readonly client: TextGenerationClient) {}

  async analyze(input: TriggerAnalysisGatewayInput): Promise<TriggerAnalysisResult> {
    const raw = await this.client.complete({
      systemPrompt: getTriggerAnalysisSystemPrompt(),
      prompt: buildTriggerAnalysisPrompt({
        query: input.query,
        activeQuery: input.activeQuery,
        context: formatConversationContext(input.contextMessages),
        rules: input.rules,
      }),
    });

    return parseStructuredTriggerAnalysis(raw, input.rules);
  }
}

export class ModelQueryRewriteGateway implements QueryRewriteGateway {
  constructor(private readonly client: TextGenerationClient) {}

  async rewrite(input: {
    query: string;
    contextMessages: MessageRecord[];
    semanticRewriteInstructions?: string;
    lexicalRewriteInstructions?: string;
    answerScopeReference?: string;
  }): Promise<StructuredRewriteResult> {
    const raw = await this.client.complete({
      prompt: buildQueryRewritePrompt({
        context: formatConversationContext(input.contextMessages),
        semanticRewriteInstructions: input.semanticRewriteInstructions,
        lexicalRewriteInstructions: input.lexicalRewriteInstructions,
        answerScopeReference: input.answerScopeReference,
        query: input.query,
      }),
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
    semanticRewriteInstructions?: string;
    lexicalRewriteInstructions?: string;
    answerScopeReference?: string;
  }): Promise<StructuredRewriteResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "user",
          content: buildQueryRewritePrompt({
            context: formatConversationContext(input.contextMessages),
            semanticRewriteInstructions: input.semanticRewriteInstructions,
            lexicalRewriteInstructions: input.lexicalRewriteInstructions,
            answerScopeReference: input.answerScopeReference,
            query: input.query,
          }),
        },
      ],
    });

    const raw = response.choices?.[0]?.message?.content?.trim() ?? "";
    return parseStructuredRewrite(raw);
  }
}

export class QueryRewriteService {
  private readonly eligibilityService = new RewriteEligibilityService();

  constructor(
    private readonly gateway?: QueryRewriteGateway,
    private readonly triggerGateway?: TriggerAnalysisGateway,
  ) {}

  async rewrite(input: {
    query: string;
    contextWindow: ConversationContextWindow;
    enabled: boolean;
    intentRoutingEnabled?: boolean;
    semanticRewriteInstructions?: string;
    lexicalRewriteInstructions?: string;
    answerScopeReference?: string;
  }): Promise<RewrittenRetrievalQuery> {
    const shouldInterpret = input.enabled || input.intentRoutingEnabled !== false;

    if (!shouldInterpret) {
      return this.skipped(input.query);
    }

    if (!this.shouldRewrite()) {
      return this.skipped(input.query);
    }

    try {
      const hasConversationContext = input.contextWindow.selectedMessages.length > 0;
      const rawResult = await this.gateway?.rewrite({
        query: input.query,
        contextMessages: input.contextWindow.selectedMessages,
        semanticRewriteInstructions: input.semanticRewriteInstructions,
        lexicalRewriteInstructions: input.lexicalRewriteInstructions,
        answerScopeReference: input.answerScopeReference,
      });
      const result = this.normalizeStructuredResult(input.query, rawResult);
      const rawResponseIntent = this.normalizeResponseIntent(result.responseIntent);
      const responseIntent = this.shouldRouteScopeClassifiedRequestToRetrieval(result)
        || this.shouldRescueProceduralQuery(input.query, result)
        ? RESPONSE_INTENT.RETRIEVAL
        : rawResponseIntent;
      const normalizedStructuredResult = {
        ...result,
        responseIntent,
      };
      const lowConfidenceNonRetrieval =
        responseIntent !== RESPONSE_INTENT.RETRIEVAL
        && normalizedStructuredResult.confidence < NON_RETRIEVAL_INTENT_CONFIDENCE_THRESHOLD;

      if (lowConfidenceNonRetrieval) {
        return {
          ...this.fallback(input.query, "intent_low_confidence"),
          confidence: normalizedStructuredResult.confidence,
          intentFallbackApplied: true,
          structuredResult: normalizedStructuredResult,
        };
      }

      if (!input.enabled) {
        return this.intentOnlyResult({
          query: input.query,
          result: normalizedStructuredResult,
          responseIntent,
        });
      }

      const semanticQuery = this.selectSemanticQuery(
        input.query,
        normalizedStructuredResult.semanticQuery ?? normalizedStructuredResult.rewrittenQuery,
        hasConversationContext,
      );
      const lexicalQuery = this.selectLexicalQuery(
        input.query,
        normalizedStructuredResult.lexicalQuery ?? normalizedStructuredResult.rewrittenQuery,
        hasConversationContext,
      );
      const compatibilityRewrite = semanticQuery;
      const responseLanguagePolicy = normalizedStructuredResult.responseLanguagePolicy ?? DEFAULT_RESPONSE_LANGUAGE_POLICY;
      const lexicalRewriteAccepted = lexicalQuery !== input.query;
      const retrievalSubqueries =
        normalizedStructuredResult.retrievalSubqueries ??
        (lexicalRewriteAccepted
          ? buildLexicalAlternativeSubqueries({
              semanticQuery,
              lexicalQuery,
              responseLanguagePolicy,
            })
          : undefined);
      const applied =
        responseIntent !== RESPONSE_INTENT.RETRIEVAL
        || semanticQuery !== input.query
        || lexicalQuery !== input.query
        || Boolean(retrievalSubqueries && retrievalSubqueries.length > 1);

      if (!applied) {
        return {
          ...this.fallback(input.query, "rewrite_unusable"),
          responseIntent,
          structuredResult: {
            ...normalizedStructuredResult,
            rewrittenQuery: compatibilityRewrite,
            semanticQuery,
            lexicalQuery,
          },
        };
      }

      const structuredResult = {
        ...normalizedStructuredResult,
        rewrittenQuery: compatibilityRewrite,
        semanticQuery,
        lexicalQuery,
        retrievalSubqueries: stripLexicalPlans(retrievalSubqueries),
      };
      const eligibility = this.eligibilityService.evaluate({
        originalQuery: input.query,
        rewrite: structuredResult,
      });
      const retrievalEligible = responseIntent === RESPONSE_INTENT.RETRIEVAL
        ? eligibility.eligible
        : false;

      return {
        originalQuery: input.query,
        rewrittenQuery: compatibilityRewrite,
        effectiveQuery: retrievalEligible ? semanticQuery : input.query,
        semanticQuery: retrievalEligible ? semanticQuery : input.query,
        lexicalQuery: retrievalEligible ? lexicalQuery : input.query,
        responseIntent,
        responseLanguagePolicy,
        retrievalSubqueries: retrievalEligible ? retrievalSubqueries : undefined,
        rewriteApplied: retrievalEligible,
        retrievalEligible,
        status: retrievalEligible || responseIntent !== RESPONSE_INTENT.RETRIEVAL ? REWRITE_STATUS.APPLIED : REWRITE_STATUS.REJECTED,
        confidence: normalizedStructuredResult.confidence ?? 0.5,
        structuredResult,
        rejectionReason: responseIntent === RESPONSE_INTENT.RETRIEVAL ? eligibility.rejectionReason : undefined,
      };
    } catch {
      return this.fallback(input.query, "rewrite_failed");
    }
  }

  async analyzeTriggers(input: {
    query: string;
    activeQuery?: string;
    contextMessages?: MessageRecord[];
    metadataRules: RetrievalMetadataRule[];
  }): Promise<TriggerAnalysisResult> {
    const triggerableRules = input.metadataRules.filter(
      (rule) => rule.enabled && rule.triggerMode === "match_turn" && typeof rule.triggerInstruction === "string",
    );

    if (triggerableRules.length === 0) {
      return {
        status: "skipped_not_configured",
        consideredRules: [],
        matchedRuleIds: [],
        unmatchedRuleIds: [],
        matchCount: 0,
        matcherVersion: "none",
      };
    }

    if (!this.triggerGateway) {
      return {
        status: "skipped_unavailable",
        consideredRules: triggerableRules.map((rule) => ({
          ruleId: rule.id,
          matched: false,
          matchStrength: 0,
          reason: "Trigger analysis gateway unavailable.",
          triggerInstructionPreview: rule.triggerInstruction ?? "",
        })),
        matchedRuleIds: [],
        unmatchedRuleIds: triggerableRules.map((rule) => rule.id),
        matchCount: 0,
        matcherVersion: "unavailable",
        failureReason: "trigger_gateway_unavailable",
      };
    }

    try {
      const result = await this.triggerGateway.analyze({
        query: input.query,
        activeQuery: input.activeQuery ?? input.query,
        contextMessages: input.contextMessages ?? [],
        rules: triggerableRules,
      });
      const normalizedConsideredRules = result.consideredRules.map((rule) => {
        const thresholdMet = rule.matchStrength >= TRIGGER_MATCH_ENACTMENT_THRESHOLD;
        const thresholdGuardedMatch = rule.matched && thresholdMet;

        return {
          ...rule,
          matched: thresholdGuardedMatch,
          reason: thresholdGuardedMatch
            ? rule.reason.trim()
            : rule.matched
              ? `${rule.reason.trim()} Match strength ${rule.matchStrength.toFixed(2)} is below the enactment threshold ${TRIGGER_MATCH_ENACTMENT_THRESHOLD.toFixed(2)}.`
              : rule.reason.trim(),
          triggerInstructionPreview: rule.triggerInstructionPreview.trim(),
        };
      });
      const matchedRuleIds = normalizedConsideredRules.filter((rule) => rule.matched).map((rule) => rule.ruleId);
      const unmatchedRuleIds = normalizedConsideredRules.filter((rule) => !rule.matched).map((rule) => rule.ruleId);

      return {
        status: result.status,
        consideredRules: normalizedConsideredRules,
        matchedRuleIds,
        unmatchedRuleIds,
        matchCount: matchedRuleIds.length,
        matcherVersion: result.matcherVersion,
        failureReason: result.failureReason,
      };
    } catch {
      return {
        status: "fallback",
        consideredRules: triggerableRules.map((rule) => ({
          ruleId: rule.id,
          matched: false,
          matchStrength: 0,
          reason: "Trigger analysis failed; baseline retrieval preserved.",
          triggerInstructionPreview: truncateTriggerInstruction(rule.triggerInstruction ?? ""),
        })),
        matchedRuleIds: [],
        unmatchedRuleIds: triggerableRules.map((rule) => rule.id),
        matchCount: 0,
        matcherVersion: "fallback",
        failureReason: "trigger_analysis_failed",
      };
    }
  }

  private shouldRewrite(): boolean {
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
      responseIntent: RESPONSE_INTENT.RETRIEVAL,
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
      responseIntent: RESPONSE_INTENT.RETRIEVAL,
      fallbackReason: reason,
    };
  }

  private intentOnlyResult(input: {
    query: string;
    result: StructuredRewriteResult;
    responseIntent: ResponseIntent;
  }): RewrittenRetrievalQuery {
    if (input.responseIntent === RESPONSE_INTENT.RETRIEVAL) {
      return {
        ...this.skipped(input.query),
        confidence: input.result.confidence,
        responseLanguagePolicy: input.result.responseLanguagePolicy ?? DEFAULT_RESPONSE_LANGUAGE_POLICY,
        structuredResult: input.result,
      };
    }

    return {
      originalQuery: input.query,
      rewrittenQuery: input.query,
      effectiveQuery: input.query,
      semanticQuery: input.query,
      lexicalQuery: input.query,
      responseIntent: input.responseIntent,
      responseLanguagePolicy: input.result.responseLanguagePolicy ?? DEFAULT_RESPONSE_LANGUAGE_POLICY,
      retrievalSubqueries: undefined,
      rewriteApplied: false,
      retrievalEligible: false,
      status: REWRITE_STATUS.SKIPPED,
      confidence: input.result.confidence,
      structuredResult: {
        ...input.result,
        rewrittenQuery: input.query,
        semanticQuery: input.query,
        lexicalQuery: input.query,
      },
    };
  }

  private normalizeRewrite(rewrittenQuery?: string): string {
    const normalized = (rewrittenQuery ?? "")
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .replace(/^rewritten query:\s*/i, "")
      .replace(/^query:\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();

    return stripSingleWrappingQuotePair(normalized);
  }

  private normalizeStructuredResult(
    originalQuery: string,
    result?: QueryRewriteGatewayResult,
  ): StructuredRewriteResult {
    if (result && "turnKind" in result) {
      const semanticQuery = this.normalizeRewrite(result.semanticQuery ?? result.rewrittenQuery);
      const lexicalQuery = this.normalizeLexicalRewrite(result.lexicalQuery ?? result.rewrittenQuery);
      const responseLanguagePolicy = this.normalizeResponseLanguagePolicy(result.responseLanguagePolicy);

      return {
        rewrittenQuery: this.normalizeRewrite(result.rewrittenQuery),
        semanticQuery,
        lexicalQuery,
        responseIntent: this.normalizeResponseIntent(result.responseIntent),
        intentTopic: this.normalizeIntentTopic(result.intentTopic),
        inScopeRequest: this.normalizeScopeRequest(result.inScopeRequest),
        outsideScopeRequest: this.normalizeScopeRequest(result.outsideScopeRequest),
        responseLanguagePolicy,
        responseLanguage: this.normalizeResponseLanguage(result.responseLanguage),
        queryShape: this.normalizeQueryShape(result.queryShape),
        retrievalSubqueries: this.normalizeRetrievalSubqueries(result.retrievalSubqueries),
        turnKind: this.normalizeTurnKind(result.turnKind),
        proposedActiveSubject: this.normalizeClassifierLabel(result.proposedActiveSubject),
        relatedEntities: this.normalizeClassifierLabels(result.relatedEntities),
        unresolved: Boolean(result.unresolved),
        confidence: result.confidence ?? 0.5,
      };
    }

    return {
      rewrittenQuery: this.normalizeRewrite(result?.rewrittenQuery ?? originalQuery),
      semanticQuery: this.normalizeRewrite(result?.semanticQuery ?? result?.rewrittenQuery ?? originalQuery),
      lexicalQuery: this.normalizeLexicalRewrite(result?.lexicalQuery ?? result?.rewrittenQuery ?? originalQuery),
      responseIntent: RESPONSE_INTENT.RETRIEVAL,
      intentTopic: undefined,
      inScopeRequest: undefined,
      outsideScopeRequest: undefined,
      responseLanguagePolicy: DEFAULT_RESPONSE_LANGUAGE_POLICY,
      responseLanguage: undefined,
      queryShape: undefined,
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

  private normalizeQueryShape(queryShape?: string): RetrievalQueryShape | undefined {
    switch (queryShape) {
      case "definition_lookup":
      case "event_date_lookup":
      case "policy_answer":
      case "exploratory_summary":
      case "follow_up_grounding":
      case "default_hybrid":
      case "general_grounding":
        return queryShape;
      default:
        return undefined;
    }
  }

  private normalizeRetrievalSubqueries(retrievalSubqueries?: RetrievalSubquery[]): RetrievalSubquery[] | undefined {
    if (!Array.isArray(retrievalSubqueries)) {
      return undefined;
    }

    const normalized = retrievalSubqueries
      .map((subquery, index) => {
        const label = this.normalizeRetrievalSubqueryLabel(subquery?.label);
        const semanticQuery = this.normalizeRewrite(subquery?.semanticQuery);
        const lexicalQuery = this.normalizeLexicalRewrite(subquery?.lexicalQuery ?? semanticQuery);
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

  private normalizeRetrievalSubqueryLabel(value?: string): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const normalized = value
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
      .replace(/[`#*_~[\]{}]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (
      normalized.length === 0 ||
      normalized.length > 80 ||
      /\b(?:bypass|developer|ignore|instructions?|jailbreak|override|previous|prompt|raw|reveal|system)\b/i.test(normalized) ||
      !/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} '&/().,:°-]*$/u.test(normalized)
    ) {
      return undefined;
    }

    return normalized.split(/[\s/-]+/).filter(Boolean).length > 8 ? undefined : normalized;
  }

  private normalizeLexicalRewrite(rewrittenQuery?: string): string {
    return (rewrittenQuery ?? "")
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .replace(/^rewritten query:\s*/i, "")
      .replace(/^query:\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private normalizeResponseLanguagePolicy(value?: string): ResponseLanguagePolicy {
    return value === "match_user_question" ? value : DEFAULT_RESPONSE_LANGUAGE_POLICY;
  }

  private normalizeResponseLanguage(value?: string): string | undefined {
    return normalizeLlmClassifierLanguageLabel(value);
  }

  private normalizeClassifierLabel(value?: string): string | undefined {
    return normalizeLlmClassifierLabel(value);
  }

  private normalizeClassifierLabels(values?: string[]): string[] {
    if (!Array.isArray(values)) {
      return [];
    }

    return [
      ...new Set(
        values
          .map((value) => this.normalizeClassifierLabel(value))
          .filter((value): value is string => Boolean(value)),
      ),
    ].slice(0, 8);
  }

  private normalizeResponseIntent(value?: string): ResponseIntent {
    switch (value) {
      case RESPONSE_INTENT.SOCIAL_ONLY:
      case RESPONSE_INTENT.ASSISTANT_IDENTITY:
      case RESPONSE_INTENT.RETRIEVAL:
        return value;
      default:
        return RESPONSE_INTENT.RETRIEVAL;
    }
  }

  private shouldRescueProceduralQuery(query: string, result: StructuredRewriteResult): boolean {
    if (this.normalizeResponseIntent(result.responseIntent) !== RESPONSE_INTENT.SOCIAL_ONLY) {
      return false;
    }

    const classifierText = [
      query,
      result.intentTopic,
      result.inScopeRequest,
      result.outsideScopeRequest,
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" ");

    if (SELF_CONTAINED_NON_RETRIEVAL_PATTERN.test(classifierText)) {
      return false;
    }

    return PROCEDURAL_LOOKUP_PATTERN.test(query);
  }

  private shouldRouteScopeClassifiedRequestToRetrieval(result: StructuredRewriteResult): boolean {
    if (this.normalizeResponseIntent(result.responseIntent) !== RESPONSE_INTENT.SOCIAL_ONLY) {
      return false;
    }

    const hasScopeRequest =
      (typeof result.inScopeRequest === "string" && result.inScopeRequest.trim().length > 0)
      || (typeof result.outsideScopeRequest === "string" && result.outsideScopeRequest.trim().length > 0);

    return hasScopeRequest;
  }

  private normalizeIntentTopic(value?: string): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    return this.normalizeClassifierLabel(value);
  }

  private normalizeScopeRequest(value?: string): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const normalized = value
      .replace(/[`#_~[\]()]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240)
      .trim();

    if (normalized.toLowerCase() === "null") {
      return undefined;
    }

    return normalized.length > 0 ? normalized : undefined;
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

    if (!hasConversationContext && !this.isFocusedLexicalQuery(originalQuery, selected)) {
      return originalQuery;
    }

    return selected;
  }

  private isFocusedLexicalQuery(originalQuery: string, candidateQuery: string): boolean {
    const originalTerms = tokenizeRewriteTerms(originalQuery);
    const candidateTerms = tokenizeRewriteTerms(candidateQuery);

    if (candidateTerms.length === 0 || candidateTerms.length >= originalTerms.length) {
      return false;
    }

    const originalTermSet = new Set(originalTerms);
    return candidateTerms.every((term) => originalTermSet.has(term));
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

const PROCEDURAL_LOOKUP_PATTERN =
  /\b(?:how\s+(?:do|can|could|should)\s+i|how\s+to|where\s+(?:do|can|could|should)\s+i|what\s+(?:do|should)\s+i\s+do|can\s+i|could\s+i|is\s+it\s+possible\s+to|i\s+(?:can'?t|cannot)\s+(?:access|log\s*in|login|sign\s*in|change|reset|recover|find|book|register|enroll|cancel|update)|help\s+me\s+(?:access|log\s*in|login|sign\s*in|change|reset|recover|find|book|register|enroll|cancel|update)|need\s+help\s+(?:with|to))\b/i;

const SELF_CONTAINED_NON_RETRIEVAL_PATTERN =
  /\b(?:arithmetic|calculate|calculation|compute|equation|math|sqrt|square\s+root|python|javascript|typescript|java|regex|sql|code|coding|programming|syntax|debug|translate|translation|trivia|joke|poem|story|draft\s+(?:an?\s+)?(?:email|message|letter|reply)|medical|legal|financial|relationship)\b/i;

const stripSingleWrappingQuotePair = (value: string): string => {
  const first = value[0];
  const last = value[value.length - 1];
  if ((first !== '"' && first !== "'") || first !== last) {
    return value;
  }

  const quoteCount = [...value].filter((char) => char === first).length;
  return quoteCount === 2 ? value.slice(1, -1).trim() : value;
};

const stripLexicalPlans = (subqueries?: RetrievalSubquery[]): RetrievalSubquery[] | undefined =>
  subqueries?.map(({ lexicalPlan: _lexicalPlan, ...subquery }) => subquery);

const truncateTriggerInstruction = (value: string): string => value.trim().replace(/\s+/g, " ").slice(0, 160);

const stripJsonFence = (value: string): string =>
  value
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

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
    responseIntent:
      typeof parsed.responseIntent === "string"
        ? (
            parsed.responseIntent === RESPONSE_INTENT.SOCIAL_ONLY
            || parsed.responseIntent === RESPONSE_INTENT.ASSISTANT_IDENTITY
            || parsed.responseIntent === RESPONSE_INTENT.RETRIEVAL
              ? parsed.responseIntent
              : RESPONSE_INTENT.RETRIEVAL
          )
        : RESPONSE_INTENT.RETRIEVAL,
    intentTopic: typeof parsed.intentTopic === "string" ? parsed.intentTopic : undefined,
    inScopeRequest: typeof parsed.inScopeRequest === "string" ? parsed.inScopeRequest : undefined,
    outsideScopeRequest: typeof parsed.outsideScopeRequest === "string" ? parsed.outsideScopeRequest : undefined,
    responseLanguagePolicy:
      typeof parsed.responseLanguagePolicy === "string" && parsed.responseLanguagePolicy === "match_user_question"
        ? parsed.responseLanguagePolicy
        : DEFAULT_RESPONSE_LANGUAGE_POLICY,
    responseLanguage: typeof parsed.responseLanguage === "string" ? parsed.responseLanguage : undefined,
    queryShape:
      typeof parsed.queryShape === "string" &&
      (
        parsed.queryShape === "definition_lookup" ||
        parsed.queryShape === "event_date_lookup" ||
        parsed.queryShape === "policy_answer" ||
        parsed.queryShape === "exploratory_summary" ||
        parsed.queryShape === "follow_up_grounding" ||
        parsed.queryShape === "default_hybrid" ||
        parsed.queryShape === "general_grounding"
      )
        ? parsed.queryShape
        : undefined,
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

const parseStructuredTriggerAnalysis = (
  raw: string,
  rules: RetrievalMetadataRule[],
): TriggerAnalysisResult => {
  const fallback = {
    status: "fallback" as const,
    consideredRules: rules.map((rule) => ({
      ruleId: rule.id,
      matched: false,
      matchStrength: 0,
      reason: "Trigger analysis response was malformed; baseline retrieval preserved.",
      triggerInstructionPreview: truncateTriggerInstruction(rule.triggerInstruction ?? ""),
    })),
    matchedRuleIds: [] as string[],
    unmatchedRuleIds: rules.map((rule) => rule.id),
    matchCount: 0,
    matcherVersion: "fallback",
    failureReason: "trigger_analysis_malformed",
  };

  try {
    const parsed = JSON.parse(stripJsonFence(raw)) as {
      matches?: Array<{
        ruleId?: string;
        matched?: boolean;
        matchStrength?: number;
        reason?: string;
      }>;
      matcherVersion?: string;
    };

    const entryByRuleId = new Map(
      Array.isArray(parsed.matches)
        ? parsed.matches
            .filter((entry) => typeof entry?.ruleId === "string")
            .map((entry) => [entry.ruleId!, entry] as const)
        : [],
    );

    const consideredRules = rules.map((rule) => {
      const entry = entryByRuleId.get(rule.id);
      return {
        ruleId: rule.id,
        matched: entry?.matched === true,
        matchStrength:
          typeof entry?.matchStrength === "number" && Number.isFinite(entry.matchStrength)
            ? Math.max(0, Math.min(1, entry.matchStrength))
            : 0,
        reason:
          typeof entry?.reason === "string" && entry.reason.trim().length > 0
            ? entry.reason.trim().slice(0, 240)
            : "No trigger match explanation returned.",
        triggerInstructionPreview: truncateTriggerInstruction(rule.triggerInstruction ?? ""),
      };
    });

    const matchedRuleIds = consideredRules.filter((rule) => rule.matched).map((rule) => rule.ruleId);
    const unmatchedRuleIds = consideredRules.filter((rule) => !rule.matched).map((rule) => rule.ruleId);

    return {
      status: "applied",
      consideredRules,
      matchedRuleIds,
      unmatchedRuleIds,
      matchCount: matchedRuleIds.length,
      matcherVersion:
        typeof parsed.matcherVersion === "string" && parsed.matcherVersion.trim().length > 0
          ? parsed.matcherVersion.trim()
          : "model_v1",
    };
  } catch {
    return fallback;
  }
};
