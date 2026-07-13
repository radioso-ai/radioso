import { z } from "zod";

import {
  metadataRuleCombinators,
  metadataRuleEffects,
  metadataRuleOperators,
  metadataRuleTriggerModes,
  metadataValueTypes,
  defaultRetrievalSettings,
  normalizeMetadataRules,
  validateRetrievalSettings,
  retrievalStrategyPreferences,
  type RetrievalSettingsRecord,
} from "../../settings/contracts/retrieval.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";

export const retrievalMetadataConditionOverrideSchema = z.object({
  id: z.string().min(1),
  field: z.string().min(1),
  valueType: z.enum(metadataValueTypes),
  operator: z.enum(metadataRuleOperators),
  value: z.string(),
});

export const retrievalMetadataRuleOverrideSchema = z.object({
  id: z.string().min(1),
  field: z.string().min(1).optional(),
  valueType: z.enum(metadataValueTypes).optional(),
  operator: z.enum(metadataRuleOperators).optional(),
  value: z.string().optional(),
  combinator: z.enum(metadataRuleCombinators).optional(),
  conditions: z.array(retrievalMetadataConditionOverrideSchema).optional(),
  effect: z.enum(metadataRuleEffects),
  enabled: z.boolean(),
  triggerMode: z.enum(metadataRuleTriggerModes).optional(),
  triggerInstruction: z.string().max(500).optional(),
});

const retrievalSkillSettingsOverrideShape = {
  queryRewriteEnabled: z.boolean().optional(),
  temporalStructuredLookupEnabled: z.boolean().optional(),
  temporalBoostUpcomingEnabled: z.boolean().optional(),
  temporalDeterministicSortEnabled: z.boolean().optional(),
  semanticRewriteInstructions: z.string().max(2000).optional(),
  lexicalRewriteInstructions: z.string().max(2000).optional(),
  suggestedQuestionsEnabled: z.boolean().optional(),
  suggestedQuestionsCount: z.number().int().min(1).max(4).optional(),
  rerankEnabled: z.boolean().optional(),
  vectorTopK: z.number().int().min(1).max(300).optional(),
  rerankTopK: z.number().int().min(1).max(RETRIEVAL_BEHAVIOR.rerank.candidateLimit).optional(),
  retrievalStrategy: z.enum(retrievalStrategyPreferences).optional(),
  metadataRules: z.array(retrievalMetadataRuleOverrideSchema).optional(),
  customInstruction: z.string().max(2000).optional(),
};

export const retrieveSkillSourceScopeSchema = z.union([
  z.literal("all"),
  z.object({
    sourceIds: z.array(z.string().uuid()).max(200),
  }).strict(),
]);

export const retrieveSkillExposedInputsSchema = z.object({
  query: z.literal(true).default(true),
}).strict();

export const retrieveSkillConfigSchema = z.object({
  sourceScope: retrieveSkillSourceScopeSchema.default("all"),
  instruction: z.string().max(2000).optional(),
  retrievalStrategy: retrievalSkillSettingsOverrideShape.retrievalStrategy,
  vectorTopK: retrievalSkillSettingsOverrideShape.vectorTopK,
  rerankEnabled: retrievalSkillSettingsOverrideShape.rerankEnabled,
  rerankTopK: retrievalSkillSettingsOverrideShape.rerankTopK,
  queryRewriteEnabled: retrievalSkillSettingsOverrideShape.queryRewriteEnabled,
  temporalStructuredLookupEnabled: retrievalSkillSettingsOverrideShape.temporalStructuredLookupEnabled,
  temporalBoostUpcomingEnabled: retrievalSkillSettingsOverrideShape.temporalBoostUpcomingEnabled,
  temporalDeterministicSortEnabled: retrievalSkillSettingsOverrideShape.temporalDeterministicSortEnabled,
  semanticRewriteInstructions: retrievalSkillSettingsOverrideShape.semanticRewriteInstructions,
  lexicalRewriteInstructions: retrievalSkillSettingsOverrideShape.lexicalRewriteInstructions,
  suggestedQuestionsEnabled: retrievalSkillSettingsOverrideShape.suggestedQuestionsEnabled,
  suggestedQuestionsCount: retrievalSkillSettingsOverrideShape.suggestedQuestionsCount,
  metadataRules: retrievalSkillSettingsOverrideShape.metadataRules,
  exposedInputs: retrieveSkillExposedInputsSchema.default({ query: true }),
}).strict();

export type RetrieveSkillConfig = z.infer<typeof retrieveSkillConfigSchema>;

// Keep this aligned with the retrieval.answer manifest's RetrievalSettingsOverride.
// Per-agent policy intentionally excludes similarityThreshold because it is model-coupled.
export const retrievalSkillSettingsOverrideSchema = z.object(retrievalSkillSettingsOverrideShape).strict();

export type RetrievalSkillSettingsOverride = z.infer<typeof retrievalSkillSettingsOverrideSchema>;
export type EffectiveRetrievalSkillSettings = RetrievalSettingsRecord;

export const normalizeRetrievalSkillSettingsOverride = (input: unknown): RetrievalSkillSettingsOverride => {
  const parsed = retrievalSkillSettingsOverrideSchema.parse(input);
  if (parsed.metadataRules === undefined) {
    return parsed;
  }

  const validated = validateRetrievalSettings({
    ...defaultRetrievalSettings("__agent_skill_settings_validation__"),
    ...parsed,
    metadataRules: normalizeMetadataRules(parsed.metadataRules),
  });

  return {
    ...parsed,
    metadataRules: validated.metadataRules,
  };
};

export const parsePersistedRetrievalSkillSettingsOverride = (input: unknown): RetrievalSkillSettingsOverride => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const record = input as Record<string, unknown>;
  const parsed: Record<string, unknown> = {};

  for (const [key, schema] of Object.entries(retrievalSkillSettingsOverrideShape)) {
    if (key === "metadataRules" || record[key] === undefined) {
      continue;
    }
    const result = schema.safeParse(record[key]);
    if (result.success) {
      parsed[key] = result.data;
    }
  }

  if (
    record.metadataRules !== undefined &&
    retrievalSkillSettingsOverrideShape.metadataRules.safeParse(record.metadataRules).success
  ) {
    parsed.metadataRules = normalizeMetadataRules(record.metadataRules);
  }

  return parsed as RetrievalSkillSettingsOverride;
};

export const parseRetrieveSkillConfig = (input: unknown): RetrieveSkillConfig =>
  retrieveSkillConfigSchema.parse(input);

export const retrieveSkillConfigToSettingsOverride = (config: RetrieveSkillConfig): RetrievalSkillSettingsOverride => {
  const {
    sourceScope: _sourceScope,
    instruction,
    exposedInputs: _exposedInputs,
    ...settings
  } = config;
  return {
    ...settings,
    ...(instruction !== undefined ? { customInstruction: instruction } : {}),
  };
};
