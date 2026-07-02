import { z } from "zod";

import { chunkingStrategyIds } from "../../../modules/retrieval/public.js";
import { embeddingModelIds } from "../../../modules/settings/contracts/ingestion.js";
import {
  metadataRuleCombinators,
  metadataRuleEffects,
  metadataRuleOperators,
  metadataRuleTriggerModes,
  metadataValueTypes,
  retrievalStrategyPreferences,
} from "../../../modules/settings/contracts/retrieval.js";
import { websiteEmbedLauncherPositions } from "../../../shared/domain/websiteEmbed.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { assistantThemeSchema } from "../shared/assistantIdentity.js";

export const updateSettingsSchema = z.object({
  queryRewriteEnabled: z.boolean(),
  semanticRewriteInstructions: z.string().max(2000).optional(),
  lexicalRewriteInstructions: z.string().max(2000).optional(),
  suggestedQuestionsEnabled: z.boolean().optional(),
  suggestedQuestionsCount: z.number().int().min(1).max(4).optional(),
  rerankEnabled: z.boolean(),
  vectorTopK: z.number().int().min(1),
  similarityThreshold: z.number(),
  rerankTopK: z.number().int().max(RETRIEVAL_BEHAVIOR.rerank.candidateLimit),
  retrievalStrategy: z.enum(retrievalStrategyPreferences).optional(),
  metadataRules: z
    .array(
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
    )
    .optional(),
  customInstruction: z.string().max(2000).optional(),
});

export const updateGeneralSettingsSchema = z.object({
  anonymousChatEnabled: z.boolean().optional(),
  assistantName: z.string().max(200).optional(),
  greetingInstruction: z.string().max(200).optional(),
  assistantDefaultLocale: z.string().max(35).nullable().optional(),
  proactiveGreetingEnabled: z.boolean().optional(),
  websiteEmbedEnabled: z.boolean().optional(),
  websiteEmbedAllowedOrigins: z.array(z.string().max(200)).max(20).optional(),
  websiteEmbedLauncherLabel: z.string().max(80).optional(),
  websiteEmbedLauncherPosition: z.enum(websiteEmbedLauncherPositions).optional(),
  websiteEmbedTheme: assistantThemeSchema.optional(),
  websiteEmbedCopy: z.record(z.record(z.string().max(500))).optional(),
  websiteEmbedExpertOverrides: z.record(z.string().max(500)).optional(),
});

export const updatePlatformSettingsSchema = z.object({
  assistant: z.object({
    assistantName: z.string().max(200).optional(),
    greetingInstruction: z.string().max(200).optional(),
    assistantDefaultLocale: z.string().max(35).nullable().optional(),
    proactiveGreetingEnabled: z.boolean().optional(),
    suggestedQuestionsEnabled: z.boolean().optional(),
    customInstruction: z.string().max(2000).optional(),
  }).optional(),
  channels: z.object({
    anonymousChatEnabled: z.boolean().optional(),
    websiteEmbedEnabled: z.boolean().optional(),
    websiteEmbedAllowedOrigins: z.array(z.string().max(200)).max(20).optional(),
    websiteEmbedLauncherLabel: z.string().max(80).optional(),
    websiteEmbedLauncherPosition: z.enum(websiteEmbedLauncherPositions).optional(),
    websiteEmbedTheme: updateGeneralSettingsSchema.shape.websiteEmbedTheme,
    websiteEmbedCopy: updateGeneralSettingsSchema.shape.websiteEmbedCopy,
    websiteEmbedExpertOverrides: updateGeneralSettingsSchema.shape.websiteEmbedExpertOverrides,
  }).optional(),
});

export const updateIngestionSettingsSchema = z.object({
  chunkingStrategy: z.enum(chunkingStrategyIds),
  fixedWindowChunkSize: z.number().int()
    .min(RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkSizeMin)
    .max(RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkSizeMax),
  fixedWindowChunkOverlap: z.number().int()
    .min(RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkOverlapMin)
    .max(RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkOverlapMax),
  structuredMinChunkSize: z.number().int()
    .min(RETRIEVAL_BEHAVIOR.chunking.structuredMinChunkSizeMin)
    .max(RETRIEVAL_BEHAVIOR.chunking.structuredMinChunkSizeMax),
  structuredMaxChunkSize: z.number().int()
    .min(RETRIEVAL_BEHAVIOR.chunking.structuredMaxChunkSizeMin)
    .max(RETRIEVAL_BEHAVIOR.chunking.structuredMaxChunkSizeMax),
  embeddingModel: z.enum(embeddingModelIds).optional(),
  documentEnrichmentEnabled: z.boolean().optional(),
});

export const reprocessIngestionBodySchema = z.object({
  documentEnrichmentOverride: z.enum(["on", "off"]).optional(),
}).strict();
