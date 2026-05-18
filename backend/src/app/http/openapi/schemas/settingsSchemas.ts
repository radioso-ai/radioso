import { z } from "zod";
import {
  updateGeneralSettingsSchema,
  updateIngestionSettingsSchema,
  updatePlatformSettingsSchema,
  updateSettingsSchema,
} from "../../routes/settingsRoutes.js";
import { websiteEmbedLauncherPositions } from "../../../../modules/settings/contracts/websiteEmbed.js";
import { embeddingModelIds } from "../../../../modules/settings/contracts/ingestion.js";
import { chunkingStrategyIds } from "../../../../modules/retrieval/public.js";
import {
  metadataRuleEffects,
  metadataRuleOperators,
  metadataRuleTriggerModes,
  metadataValueTypes,
} from "../../../../modules/settings/contracts/retrieval.js";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const registerSettingsSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const RetrievalSettingsSchema = registry.register(
    "RetrievalSettings",
    z.object({
      workspaceId: z.string().uuid(),
      queryRewriteEnabled: z.boolean(),
      semanticRewriteInstructions: z.string().max(2000),
      lexicalRewriteInstructions: z.string().max(2000),
      suggestedQuestionsEnabled: z.boolean(),
      rerankEnabled: z.boolean(),
      vectorTopK: z.number().int().min(1).max(300),
      similarityThreshold: z.number().min(0).max(1),
      rerankTopK: z.number().int().min(1),
      citationDisplayEnabled: z.boolean(),
      answerSupportValidationEnabled: z.boolean(),
      metadataFieldSuggestions: z.array(
        z.object({
          field: z.string(),
          inferredType: z.enum(metadataValueTypes),
        }),
      ).default([]),
      metadataRules: z.array(
        z.object({
          id: z.string(),
          field: z.string(),
          valueType: z.enum(metadataValueTypes),
          operator: z.enum(metadataRuleOperators),
          value: z.string(),
          combinator: z.enum(["and", "or"]).default("and"),
          conditions: z.array(
            z.object({
              id: z.string(),
              field: z.string(),
              valueType: z.enum(metadataValueTypes),
              operator: z.enum(metadataRuleOperators),
              value: z.string(),
            }),
          ).default([]),
          effect: z.enum(metadataRuleEffects),
          enabled: z.boolean(),
          triggerMode: z.enum(metadataRuleTriggerModes),
          triggerInstruction: z.string().optional(),
        }),
      ).default([]),
      customInstruction: z.string().max(2000),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const UpdateRetrievalSettingsRequestSchema = registry.register(
    "UpdateRetrievalSettingsRequest",
    updateSettingsSchema,
  );
  registry.register(
    "RetrievalSettingsOverride",
    updateSettingsSchema.partial(),
  );

  const IngestionSettingsSchema = registry.register(
    "IngestionSettings",
    z.object({
      workspaceId: z.string().uuid(),
      chunkingStrategy: z.enum(chunkingStrategyIds),
      embeddingModel: z.enum(embeddingModelIds),
      pendingEmbeddingModel: z.enum(embeddingModelIds).nullable(),
      supportedEmbeddingModels: z.array(z.enum(embeddingModelIds)),
      fixedWindowChunkSize: z.number().int(),
      fixedWindowChunkOverlap: z.number().int(),
      structuredMinChunkSize: z.number().int(),
      structuredMaxChunkSize: z.number().int(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const UpdateIngestionSettingsRequestSchema = registry.register(
    "UpdateIngestionSettingsRequest",
    updateIngestionSettingsSchema,
  );

  const RetrievalMetadataRuleSchema = registry.register(
    "RetrievalMetadataRule",
    z.object({
      id: z.string(),
      field: z.string(),
      valueType: z.enum(metadataValueTypes),
      operator: z.enum(metadataRuleOperators),
      value: z.string(),
      combinator: z.enum(["and", "or"]).default("and"),
      conditions: z.array(
        z.object({
          id: z.string(),
          field: z.string(),
          valueType: z.enum(metadataValueTypes),
          operator: z.enum(metadataRuleOperators),
          value: z.string(),
        }),
      ).default([]),
      effect: z.enum(metadataRuleEffects),
      enabled: z.boolean(),
      triggerMode: z.enum(metadataRuleTriggerModes),
      triggerInstruction: z.string().optional(),
    }),
  );

  const TriggerAnalysisRuleSchema = registry.register(
    "TriggerAnalysisRule",
    z.object({
      ruleId: z.string(),
      matched: z.boolean(),
      matchStrength: z.number().min(0).max(1),
      reason: z.string(),
      triggerInstructionPreview: z.string(),
    }),
  );

  const TriggerAnalysisSchema = registry.register(
    "TriggerAnalysis",
    z.object({
      status: z.enum(["skipped_not_configured", "skipped_unavailable", "applied", "fallback"]),
      consideredRules: z.array(TriggerAnalysisRuleSchema),
      matchedRuleIds: z.array(z.string()),
      unmatchedRuleIds: z.array(z.string()),
      matchCount: z.number().int().min(0),
      matcherVersion: z.string(),
      failureReason: z.string().optional(),
    }),
  );

  const TriggerBackoffSchema = registry.register(
    "TriggerBackoff",
    z.object({
      applied: z.boolean(),
      reason: z.enum(["empty_filtered_candidates", "weak_filtered_support"]).optional(),
      relaxedRuleIds: z.array(z.string()),
      restoredCandidateCount: z.number().int().min(0).optional(),
    }),
  );

  const UpdateGeneralSettingsRequestSchema = registry.register(
    "UpdateGeneralSettingsRequest",
    updateGeneralSettingsSchema,
  );

  const GeneralSettingsResponseSchema = registry.register(
    "GeneralSettingsResponse",
    z.object({
      anonymousChatEnabled: z.boolean(),
      anonymousChatUrl: z.string().nullable(),
      assistantName: z.string(),
      greetingInstruction: z.string(),
      assistantDefaultLocale: z.string().nullable(),
      proactiveGreetingEnabled: z.boolean(),
      assistantBootstrapActive: z.boolean(),
      assistantLogoUrl: z.string().nullable(),
      websiteEmbedEnabled: z.boolean(),
      websiteEmbedToken: z.string().nullable(),
      websiteEmbedScriptUrl: z.string().nullable(),
      websiteEmbedSnippet: z.string().nullable(),
      websiteEmbedAllowedOrigins: z.array(z.string()),
      websiteEmbedLauncherLabel: z.string(),
      websiteEmbedLauncherPosition: z.enum(websiteEmbedLauncherPositions),
      websiteEmbedTheme: z.object({
        brand: z.string(),
        brandText: z.string(),
        surface: z.string(),
        text: z.string(),
      }),
      websiteEmbedCopy: z.record(z.record(z.string())),
      websiteEmbedExpertOverrides: z.record(z.string()),
    }),
  );

  const AssistantLogoUploadRequestSchema = registry.register(
    "AssistantLogoUploadRequest",
    z.object({
      logo: z.string().openapi({ format: "binary" }),
    }),
  );

  const AssistantSettingsSectionSchema = registry.register(
    "AssistantSettingsSection",
    z.object({
      assistantName: z.string(),
      greetingInstruction: z.string(),
      assistantDefaultLocale: z.string().nullable(),
      proactiveGreetingEnabled: z.boolean(),
      assistantBootstrapActive: z.boolean().openapi({
        description: "Server-managed bootstrap readiness derived from the current assistant configuration.",
        readOnly: true,
      }),
      suggestedQuestionsEnabled: z.boolean(),
      customInstruction: z.string(),
      assistantLogoUrl: z.string().nullable(),
    }),
  );

  const PlatformRetrievalSettingsSectionSchema = registry.register(
    "PlatformRetrievalSettingsSection",
    z.object({
      queryRewriteEnabled: z.boolean(),
      semanticRewriteInstructions: z.string().max(2000),
      lexicalRewriteInstructions: z.string().max(2000),
      rerankEnabled: z.boolean(),
      vectorTopK: z.number().int().min(1).max(300),
      similarityThreshold: z.number().min(0).max(1),
      rerankTopK: z.number().int().min(1),
      citationDisplayEnabled: z.boolean(),
      answerSupportValidationEnabled: z.boolean(),
      metadataRules: z.array(
        z.object({
          id: z.string(),
          field: z.string(),
          valueType: z.enum(metadataValueTypes),
          operator: z.enum(metadataRuleOperators),
          value: z.string(),
          combinator: z.enum(["and", "or"]).default("and"),
          conditions: z.array(
            z.object({
              id: z.string(),
              field: z.string(),
              valueType: z.enum(metadataValueTypes),
              operator: z.enum(metadataRuleOperators),
              value: z.string(),
            }),
          ).default([]),
          effect: z.enum(metadataRuleEffects),
          enabled: z.boolean(),
          triggerMode: z.enum(metadataRuleTriggerModes),
          triggerInstruction: z.string().optional(),
        }),
      ).default([]),
      metadataFieldSuggestions: z.array(
        z.object({
          field: z.string(),
          inferredType: z.enum(metadataValueTypes),
        }),
      ).default([]),
    }),
  );

  const PlatformChannelsSettingsSectionSchema = registry.register(
    "PlatformChannelsSettingsSection",
    z.object({
      anonymousChatEnabled: z.boolean(),
      anonymousChatUrl: z.string().nullable(),
      websiteEmbedEnabled: z.boolean(),
      websiteEmbedToken: z.string().nullable(),
      websiteEmbedAllowedOrigins: z.array(z.string()),
      websiteEmbedLauncherLabel: z.string(),
      websiteEmbedLauncherPosition: z.enum(websiteEmbedLauncherPositions),
      websiteEmbedScriptUrl: z.string().nullable(),
      websiteEmbedSnippet: z.string().nullable(),
      websiteEmbedTheme: z.object({
        brand: z.string(),
        brandText: z.string(),
        surface: z.string(),
        text: z.string(),
      }),
      websiteEmbedCopy: z.record(z.record(z.string())),
      websiteEmbedExpertOverrides: z.record(z.string()),
    }),
  );

  const AgentLogoSchema = z.object({
    bucket: z.string(),
    objectPath: z.string(),
    generation: z.string().nullable().optional(),
    mimeType: z.string(),
    filename: z.string(),
    sizeBytes: z.number(),
  }).nullable();

  const PlatformSettingsResponseSchema = registry.register(
    "PlatformSettingsResponse",
    z.object({
      assistant: AssistantSettingsSectionSchema,
      retrieval: PlatformRetrievalSettingsSectionSchema,
      channels: PlatformChannelsSettingsSectionSchema,
    }),
  );

  const UpdatePlatformSettingsRequestSchema = registry.register(
    "UpdatePlatformSettingsRequest",
    updatePlatformSettingsSchema,
  );

  Object.assign(schemas, {
    RetrievalSettingsSchema,
    UpdateRetrievalSettingsRequestSchema,
    IngestionSettingsSchema,
    UpdateIngestionSettingsRequestSchema,
    RetrievalMetadataRuleSchema,
    TriggerAnalysisRuleSchema,
    TriggerAnalysisSchema,
    TriggerBackoffSchema,
    UpdateGeneralSettingsRequestSchema,
    GeneralSettingsResponseSchema,
    AssistantLogoUploadRequestSchema,
    AssistantSettingsSectionSchema,
    PlatformRetrievalSettingsSectionSchema,
    PlatformChannelsSettingsSectionSchema,
    AgentLogoSchema,
    PlatformSettingsResponseSchema,
    UpdatePlatformSettingsRequestSchema,
  });
};
