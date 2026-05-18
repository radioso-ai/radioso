import type { RetrievalMetadataRule } from "../../settings/contracts/retrieval.js";
import type {
  RewriteTurnKind,
  StructuredRewriteResult,
  TriggerAnalysisResult,
} from "../domain/retrievalPipelineTypes.js";
import { RESPONSE_INTENT, REWRITE_TURN_KIND } from "../domain/retrievalPipelineTypes.js";
import { DEFAULT_RESPONSE_LANGUAGE_POLICY } from "./queryRewriteDefaults.js";

export const truncateTriggerInstruction = (value: string): string => value.trim().replace(/\s+/g, " ").slice(0, 160);

const stripJsonFence = (value: string): string =>
  value
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

export const parseStructuredRewrite = (raw: string): StructuredRewriteResult => {
  const parsed = JSON.parse(stripJsonFence(raw)) as Partial<StructuredRewriteResult>;
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

export const parseStructuredTriggerAnalysis = (
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
