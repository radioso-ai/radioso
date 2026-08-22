import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import {
  normalizeLlmClassifierLabel,
} from "../../../shared/domain/llmClassifierFields.js";
import type { RetrievalMetadataRule } from "../../settings/contracts/retrieval.js";
import type {
  ConversationContextWindow,
  RetrievalQueryShape,
  RetrievalSubquery,
  RewrittenRetrievalQuery,
  TriggerAnalysisResult,
  RewriteTurnKind,
  StructuredRewriteResult,
} from "../domain/retrievalPipelineTypes.js";
import { REWRITE_STATUS, REWRITE_TURN_KIND, type TemporalQueryMode } from "../domain/retrievalPipelineTypes.js";
import { buildLexicalAlternativeSubqueries } from "../domain/lexicalQueryPlan.js";
import { RewriteEligibilityService } from "./rewritePolicyService.js";
import { DEFAULT_RESPONSE_LANGUAGE_POLICY } from "./queryRewriteDefaults.js";
import { truncateTriggerInstruction } from "./queryRewriteParser.js";
import type {
  QueryRewriteGateway as QueryRewriteGatewayPort,
  QueryRewriteGatewayResult as QueryRewriteGatewayResultPort,
  TriggerAnalysisGateway as TriggerAnalysisGatewayPort,
} from "./queryRewriteGateways.js";

export {
  ModelQueryRewriteGateway,
  ModelTriggerAnalysisGateway,
  OpenAIQueryRewriteGateway,
  type QueryRewriteGateway,
  type QueryRewriteGatewayFallbackResult,
  type QueryRewriteGatewayResult,
  type TriggerAnalysisGateway,
  type TriggerAnalysisGatewayInput,
} from "./queryRewriteGateways.js";

const TRIGGER_MATCH_ENACTMENT_THRESHOLD = RETRIEVAL_BEHAVIOR.hybrid.triggerMatchEnactmentThreshold;
const resolveFallbackUsageContext = (
  input: { workspaceContext?: LlmCapabilityResolveInput; usageContext?: ModelCallUsageContext },
  operation: string,
): ModelCallUsageContext => input.usageContext ?? {
  workspaceId: input.workspaceContext?.workspaceId ?? "unknown",
  requestId: randomUUID(),
  surface: "retrieval",
  operation,
  attemptKey: "direct",
};

export class QueryRewriteService {
  private readonly eligibilityService = new RewriteEligibilityService();

  constructor(
    private readonly gateway?: QueryRewriteGatewayPort,
    private readonly triggerGateway?: TriggerAnalysisGatewayPort,
  ) {}

  async rewrite(input: {
    query: string;
    contextWindow: ConversationContextWindow;
    enabled: boolean;
    semanticRewriteInstructions?: string;
    lexicalRewriteInstructions?: string;
    workspaceContext?: LlmCapabilityResolveInput;
    usageContext?: ModelCallUsageContext;
  }): Promise<RewrittenRetrievalQuery> {
    if (!input.enabled) {
      return this.skipped(input.query);
    }

    if (!this.shouldRewrite()) {
      return this.skipped(input.query);
    }

    try {
      const rawResult = await this.gateway?.rewrite({
        query: input.query,
        contextMessages: input.contextWindow.selectedMessages,
        semanticRewriteInstructions: input.semanticRewriteInstructions,
        lexicalRewriteInstructions: input.lexicalRewriteInstructions,
        workspaceContext: input.workspaceContext,
        usageContext: resolveFallbackUsageContext(input, "query_interpretation"),
      });
      return this.rewriteFromProposal({
        query: input.query,
        contextWindow: input.contextWindow,
        enabled: input.enabled,
        proposal: rawResult,
        unusableFallbackReason: "rewrite_unusable",
      });
    } catch {
      return this.fallback(input.query, "rewrite_failed");
    }
  }

  rewriteFromProposal(input: {
    query: string;
    contextWindow: ConversationContextWindow;
    enabled: boolean;
    proposal?: QueryRewriteGatewayResultPort;
    unusableFallbackReason?: string;
  }): RewrittenRetrievalQuery {
    if (!input.enabled) {
      return this.skipped(input.query);
    }

    const hasConversationContext = input.contextWindow.selectedMessages.length > 0;
    const normalizedStructuredResult = this.normalizeStructuredResult(input.query, input.proposal);

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
    const modelRetrievalSubqueries =
      normalizedStructuredResult.retrievalSubqueries ??
      (lexicalRewriteAccepted
        ? buildLexicalAlternativeSubqueries({
            semanticQuery,
            lexicalQuery,
            responseLanguagePolicy,
          })
        : undefined);
    const resolvedLexicalQuery = this.selectResolvedSubjectLexicalQuery({
      queryShape: normalizedStructuredResult.queryShape,
      lexicalQuery,
      proposedActiveSubject: normalizedStructuredResult.proposedActiveSubject,
    });
    const retrievalSubqueries = modelRetrievalSubqueries;
    const applied =
      semanticQuery !== input.query
      || resolvedLexicalQuery !== input.query
      || Boolean(retrievalSubqueries && retrievalSubqueries.length > 1);

    if (!applied) {
      return {
        ...this.fallback(input.query, input.unusableFallbackReason ?? "rewrite_unusable"),
        structuredResult: {
          ...normalizedStructuredResult,
          rewrittenQuery: compatibilityRewrite,
          semanticQuery,
          lexicalQuery: resolvedLexicalQuery,
        },
      };
    }

    const structuredResult = {
      ...normalizedStructuredResult,
      rewrittenQuery: compatibilityRewrite,
      semanticQuery,
      lexicalQuery: resolvedLexicalQuery,
      retrievalSubqueries: stripLexicalPlans(retrievalSubqueries),
    };
    const eligibility = this.eligibilityService.evaluate({
      originalQuery: input.query,
      rewrite: structuredResult,
    });
    const retrievalEligible = eligibility.eligible;

    return {
      originalQuery: input.query,
      rewrittenQuery: compatibilityRewrite,
      effectiveQuery: retrievalEligible ? semanticQuery : input.query,
      semanticQuery: retrievalEligible ? semanticQuery : input.query,
      lexicalQuery: retrievalEligible ? resolvedLexicalQuery : input.query,
      responseLanguagePolicy,
      retrievalSubqueries: retrievalEligible ? retrievalSubqueries : undefined,
      rewriteApplied: retrievalEligible,
      retrievalEligible,
      status: retrievalEligible ? REWRITE_STATUS.APPLIED : REWRITE_STATUS.REJECTED,
      confidence: normalizedStructuredResult.confidence ?? 0.5,
      structuredResult,
      rejectionReason: eligibility.rejectionReason,
    };
  }

  async analyzeTriggers(input: {
    query: string;
    activeQuery?: string;
    contextMessages?: MessageRecord[];
    metadataRules: RetrievalMetadataRule[];
    workspaceContext?: LlmCapabilityResolveInput;
    usageContext?: ModelCallUsageContext;
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
        workspaceContext: input.workspaceContext,
        usageContext: resolveFallbackUsageContext(input, "trigger_analysis"),
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
    result?: QueryRewriteGatewayResultPort,
  ): StructuredRewriteResult {
    if (result && "turnKind" in result) {
      const semanticQuery = this.normalizeRewrite(result.semanticQuery ?? result.rewrittenQuery);
      const lexicalQuery = this.normalizeLexicalRewrite(result.lexicalQuery ?? result.rewrittenQuery);
      const responseLanguagePolicy = DEFAULT_RESPONSE_LANGUAGE_POLICY;

      return {
        rewrittenQuery: this.normalizeRewrite(result.rewrittenQuery),
        semanticQuery,
        lexicalQuery,
        responseLanguagePolicy,
        queryShape: this.normalizeQueryShape(result.queryShape),
        temporalQueryMode: this.normalizeTemporalQueryMode(result.temporalQueryMode),
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
      responseLanguagePolicy: DEFAULT_RESPONSE_LANGUAGE_POLICY,
      queryShape: undefined,
      temporalQueryMode: "none",
      retrievalSubqueries: undefined,
      turnKind: REWRITE_TURN_KIND.REFERENTIAL_FOLLOWUP,
      proposedActiveSubject: undefined,
      relatedEntities: [],
      unresolved: false,
      confidence: result?.confidence ?? 0.5,
    };
  }

  private normalizeTemporalQueryMode(temporalQueryMode?: string): TemporalQueryMode {
    switch (temporalQueryMode) {
      case "listing":
      case "topic_refinement":
        return temporalQueryMode;
      default:
        return "none";
    }
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
        const normalizedSemanticQuery = this.normalizeRewrite(subquery?.semanticQuery);
        const normalizedLexicalQuery = this.normalizeLexicalRewrite(subquery?.lexicalQuery);
        const semanticQuery = normalizedSemanticQuery || this.normalizeRewrite(normalizedLexicalQuery);
        const lexicalQuery = normalizedLexicalQuery || semanticQuery;
        if (!semanticQuery || !lexicalQuery) {
          return null;
        }

        const label = this.normalizeRetrievalSubqueryLabel(subquery?.label) ?? `Subquery ${index + 1}`;

        return {
          id: `subquery_${index + 1}`,
          label,
          semanticQuery,
          lexicalQuery,
          reason: this.normalizeOptionalRewrite(subquery?.reason),
          responseLanguagePolicy: DEFAULT_RESPONSE_LANGUAGE_POLICY,
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
      .replace(/[\u2018\u2019]/g, "'")
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

  private selectResolvedSubjectLexicalQuery(input: {
    queryShape?: RetrievalQueryShape;
    lexicalQuery: string;
    proposedActiveSubject?: string;
  }): string {
    const subject = input.proposedActiveSubject?.trim();
    if (!subject || input.queryShape !== "definition_lookup") {
      return input.lexicalQuery;
    }

    return subject;
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
