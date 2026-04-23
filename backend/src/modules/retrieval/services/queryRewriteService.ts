import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
import { loadPromptTemplate, renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { RetrievalMetadataRule } from "../../settings/domain/retrievalSettings.js";
import { getNormalizedMetadataConditions } from "../../settings/domain/retrievalSettings.js";
import type {
  ConversationContextWindow,
  RetrievalSubquery,
  RewrittenRetrievalQuery,
  ResponseLanguagePolicy,
  TriggerAnalysisResult,
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
export interface TriggerAnalysisGatewayInput {
  query: string;
  activeQuery: string;
  contextMessages: MessageRecord[];
  rules: RetrievalMetadataRule[];
}

const QUERY_REWRITE_SYSTEM_PROMPT = loadPromptTemplate("retrieval/query-rewrite-system.md");
const TRIGGER_ANALYSIS_SYSTEM_PROMPT = loadPromptTemplate("retrieval/trigger-analysis-system.md");

const DEFAULT_RESPONSE_LANGUAGE_POLICY: ResponseLanguagePolicy = "match_user_question";
const TRIGGER_MATCH_ENACTMENT_THRESHOLD = RETRIEVAL_BEHAVIOR.hybrid.triggerMatchEnactmentThreshold;

const buildQueryRewritePrompt = (input: {
  context: string;
  semanticRewriteInstructions?: string;
  lexicalRewriteInstructions?: string;
  query: string;
}): string =>
  renderPromptTemplate("retrieval/query-rewrite-user.md", {
    context_section: input.context || "No prior context",
    semantic_rewrite_instructions:
      input.semanticRewriteInstructions ?? "Use the system default semantic rewrite behavior.",
    lexical_rewrite_instructions:
      input.lexicalRewriteInstructions ?? "Use the system default lexical rewrite behavior.",
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
  }): Promise<QueryRewriteGatewayResult>;
}

export interface TriggerAnalysisGateway {
  analyze(input: TriggerAnalysisGatewayInput): Promise<TriggerAnalysisResult>;
}

export class ModelTriggerAnalysisGateway implements TriggerAnalysisGateway {
  constructor(private readonly client: TextGenerationClient) {}

  async analyze(input: TriggerAnalysisGatewayInput): Promise<TriggerAnalysisResult> {
    const raw = await this.client.complete({
      systemPrompt: TRIGGER_ANALYSIS_SYSTEM_PROMPT,
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
  }): Promise<StructuredRewriteResult> {
    const raw = await this.client.complete({
      systemPrompt: QUERY_REWRITE_SYSTEM_PROMPT,
      prompt: buildQueryRewritePrompt({
        context: formatConversationContext(input.contextMessages),
        semanticRewriteInstructions: input.semanticRewriteInstructions,
        lexicalRewriteInstructions: input.lexicalRewriteInstructions,
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
  }): Promise<StructuredRewriteResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content: QUERY_REWRITE_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: buildQueryRewritePrompt({
            context: formatConversationContext(input.contextMessages),
            semanticRewriteInstructions: input.semanticRewriteInstructions,
            lexicalRewriteInstructions: input.lexicalRewriteInstructions,
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
    semanticRewriteInstructions?: string;
    lexicalRewriteInstructions?: string;
  }): Promise<RewrittenRetrievalQuery> {
    if (!input.enabled) {
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

      if (!applied) {
        return this.fallback(input.query, "rewrite_unusable");
      }

      const structuredResult = {
        ...result,
        rewrittenQuery: compatibilityRewrite,
        semanticQuery,
        lexicalQuery,
      };
      const eligibility = this.eligibilityService.evaluate({
        originalQuery: input.query,
        rewrite: structuredResult,
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
        structuredResult,
        rejectionReason: eligibility.rejectionReason,
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
