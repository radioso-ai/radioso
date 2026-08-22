import { z } from "zod";

import { chunkingStrategyIds } from "../../../modules/retrieval/public.js";
import { documentTypeFieldValueTypes } from "../../../modules/documentTypes/contracts/documentTypeCatalog.js";
import {
  embeddingModelIds,
  manualDocumentEnrichmentOverrides,
} from "../../../modules/settings/contracts/ingestion.js";
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
  temporalStructuredLookupEnabled: z.boolean().optional(),
  temporalBoostUpcomingEnabled: z.boolean().optional(),
  temporalDeterministicSortEnabled: z.boolean().optional(),
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
  // Runtime string compatibility lets an older client echo an already-active
  // legacy model. The service rejects every unsupported value that is not the
  // persisted active value.
  embeddingModel: z.string().optional(),
  documentEnrichmentEnabled: z.boolean().optional(),
  manualDocumentEnrichmentOverride: z.enum(manualDocumentEnrichmentOverrides).optional(),
});

// The documented public contract remains the existing four-model enum. Only
// the runtime route schema is wider for the legacy equal-value no-op.
export const documentedUpdateIngestionSettingsSchema =
  updateIngestionSettingsSchema.extend({
    embeddingModel: z.enum(embeddingModelIds).optional(),
  });

export const reprocessIngestionBodySchema = z.object({
  documentEnrichmentOverride: z.enum(["on", "off"]).optional(),
}).strict();

// Transport stays permissive on lengths and key syntax: the catalog domain owns
// those rules and answers with limit-naming validation errors.
const documentTypeFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  valueType: z.enum(documentTypeFieldValueTypes),
  instruction: z.string().optional().default(""),
}).strict();

const operatorDocumentTypeSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().optional().default(""),
  enabled: z.boolean().optional().default(true),
  fields: z.array(documentTypeFieldSchema).optional().default([]),
}).strict();

export const updateDocumentTypeCatalogSchema = z.object({
  expectedRevision: z.string().min(1),
  types: z.array(operatorDocumentTypeSchema).optional().default([]),
  disabledBuiltInTypeKeys: z.array(z.string()).optional().default([]),
}).strict();

// OpenAPI mirror without `.default()`: openapi-typescript renders defaulted
// properties as required in generated request types, which would force
// clients to send fields the route happily omits.
const documentedDocumentTypeFieldSchema = documentTypeFieldSchema.extend({
  instruction: z.string().optional(),
});

const documentedOperatorDocumentTypeSchema = operatorDocumentTypeSchema.extend({
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  fields: z.array(documentedDocumentTypeFieldSchema).optional(),
});

export const documentedUpdateDocumentTypeCatalogSchema = updateDocumentTypeCatalogSchema.extend({
  types: z.array(documentedOperatorDocumentTypeSchema).optional(),
  disabledBuiltInTypeKeys: z.array(z.string()).optional(),
});
