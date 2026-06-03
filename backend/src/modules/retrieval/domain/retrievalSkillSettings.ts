import { z } from "zod";

import {
  metadataRuleCombinators,
  metadataRuleEffects,
  metadataRuleOperators,
  metadataRuleTriggerModes,
  metadataValueTypes,
  retrievalStrategyPreferences,
  type RetrievalSettingsRecord,
} from "../../settings/contracts/retrieval.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";

// Keep this aligned with the retrieval.answer manifest's RetrievalSettingsOverride.
// Per-agent policy intentionally excludes similarityThreshold because it is model-coupled.
export const retrievalSkillSettingsOverrideSchema = z.object({
  queryRewriteEnabled: z.boolean().optional(),
  semanticRewriteInstructions: z.string().max(2000).optional(),
  lexicalRewriteInstructions: z.string().max(2000).optional(),
  suggestedQuestionsEnabled: z.boolean().optional(),
  suggestedQuestionsCount: z.number().int().min(1).max(4).optional(),
  rerankEnabled: z.boolean().optional(),
  vectorTopK: z.number().int().min(1).max(300).optional(),
  rerankTopK: z.number().int().min(1).max(RETRIEVAL_BEHAVIOR.rerank.candidateLimit).optional(),
  retrievalStrategy: z.enum(retrievalStrategyPreferences).optional(),
  metadataRules: z.array(
    z.object({
      id: z.string().min(1),
      field: z.string().min(1).optional(),
      valueType: z.enum(metadataValueTypes).optional(),
      operator: z.enum(metadataRuleOperators).optional(),
      value: z.string().optional(),
      combinator: z.enum(metadataRuleCombinators).optional(),
      conditions: z.array(
        z.object({
          id: z.string().min(1),
          field: z.string().min(1),
          valueType: z.enum(metadataValueTypes),
          operator: z.enum(metadataRuleOperators),
          value: z.string(),
        }),
      ).optional(),
      effect: z.enum(metadataRuleEffects),
      enabled: z.boolean(),
      triggerMode: z.enum(metadataRuleTriggerModes).optional(),
      triggerInstruction: z.string().max(500).optional(),
    }),
  ).optional(),
  customInstruction: z.string().max(2000).optional(),
}).strict();

export type RetrievalSkillSettingsOverride = z.infer<typeof retrievalSkillSettingsOverrideSchema>;
export type EffectiveRetrievalSkillSettings = RetrievalSettingsRecord;

export const normalizeRetrievalSkillSettingsOverride = (input: unknown): RetrievalSkillSettingsOverride =>
  retrievalSkillSettingsOverrideSchema.parse(input);
