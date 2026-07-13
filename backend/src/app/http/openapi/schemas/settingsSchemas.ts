import { z } from "zod";
import {
  reprocessIngestionBodySchema,
  updateGeneralSettingsSchema,
  updateIngestionSettingsSchema,
  updatePlatformSettingsSchema,
  updateSettingsSchema,
} from "../../routes/settingsRouteSchemas.js";
import {
  providerNames,
  setProviderCredentialSchema,
} from "../../routes/settingsCredentialsRoutes.js";
import {
  updateWorkspaceLlmModelsSchema,
  workspaceLlmProviderNames,
} from "../../routes/settingsLlmModelsRoutes.js";
import {
  webhookDestinationBodySchema,
  webhookDestinationIdParamSchema,
} from "../../routes/webhookDestinationRouteSchemas.js";
import { webhookDeliveryOutcomeStatuses } from "../../../../modules/webhooks/public.js";
import { websiteEmbedLauncherPositions } from "../../../../modules/settings/contracts/websiteEmbed.js";
import { embeddingModelIds } from "../../../../modules/settings/contracts/ingestion.js";
import { chunkingStrategyIds } from "../../../../modules/retrieval/public.js";
import {
  metadataRuleEffects,
  metadataRuleOperators,
  metadataRuleTriggerModes,
  metadataValueTypes,
  retrievalStrategyPreferences,
} from "../../../../modules/settings/contracts/retrieval.js";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const registerSettingsSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const MetadataFieldSuggestionSchema = z.object({
    field: z.string(),
    inferredType: z.enum(metadataValueTypes),
  });

  const RetrievalMetadataRuleShape = z.object({
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
  });

  const RetrievalDefaultsResponseSchema = registry.register(
    "RetrievalDefaultsResponse",
    z.object({
      queryRewriteEnabled: z.boolean(),
      temporalStructuredLookupEnabled: z.boolean(),
      temporalBoostUpcomingEnabled: z.boolean(),
      temporalDeterministicSortEnabled: z.boolean(),
      semanticRewriteInstructions: z.string(),
      lexicalRewriteInstructions: z.string(),
      suggestedQuestionsEnabled: z.boolean(),
      suggestedQuestionsCount: z.number().int(),
      rerankEnabled: z.boolean(),
      vectorTopK: z.number().int(),
      rerankTopK: z.number().int(),
      retrievalStrategy: z.enum(retrievalStrategyPreferences).optional(),
      customInstruction: z.string(),
      metadataRules: z.array(RetrievalMetadataRuleShape).openapi({
        description: "Always empty for system retrieval defaults.",
      }),
      metadataFieldSuggestions: z.array(MetadataFieldSuggestionSchema),
    }),
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
      documentEnrichmentEnabled: z.boolean(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const UpdateIngestionSettingsRequestSchema = registry.register(
    "UpdateIngestionSettingsRequest",
    updateIngestionSettingsSchema,
  );

  const ReprocessIngestionRequestSchema = registry.register(
    "ReprocessIngestionRequest",
    reprocessIngestionBodySchema,
  );

  const RetrievalMetadataRuleSchema = registry.register(
    "RetrievalMetadataRule",
    RetrievalMetadataRuleShape,
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
      anonymousChatLastUsedAt: z.string().datetime().nullable(),
      assistantName: z.string(),
      greetingInstruction: z.string(),
      assistantDefaultLocale: z.string().nullable(),
      proactiveGreetingEnabled: z.boolean(),
      assistantBootstrapActive: z.boolean(),
      assistantLogoUrl: z.string().nullable(),
      websiteEmbedEnabled: z.boolean(),
      websiteEmbedToken: z.string().nullable(),
      websiteEmbedLastUsedAt: z.string().datetime().nullable(),
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

  const PlatformChannelsSettingsSectionSchema = registry.register(
    "PlatformChannelsSettingsSection",
    z.object({
      anonymousChatEnabled: z.boolean(),
      anonymousChatUrl: z.string().nullable(),
      anonymousChatLastUsedAt: z.string().datetime().nullable(),
      websiteEmbedEnabled: z.boolean(),
      websiteEmbedToken: z.string().nullable(),
      websiteEmbedLastUsedAt: z.string().datetime().nullable(),
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
      channels: PlatformChannelsSettingsSectionSchema,
    }),
  );

  const UpdatePlatformSettingsRequestSchema = registry.register(
    "UpdatePlatformSettingsRequest",
    updatePlatformSettingsSchema,
  );

  const WorkspaceProviderCredentialSummarySchema = registry.register(
    "WorkspaceProviderCredentialSummary",
    z.object({
      provider: z.enum(providerNames),
      updatedAt: z.string().datetime(),
    }),
  );

  const WorkspaceProviderCredentialsResponseSchema = registry.register(
    "WorkspaceProviderCredentialsResponse",
    z.object({
      encryptionConfigured: z.boolean(),
      credentials: z.array(WorkspaceProviderCredentialSummarySchema),
      envProviderAvailability: z.object({
        openai: z.boolean(),
        "openai-compatible": z.boolean(),
        gemini: z.boolean(),
        claude: z.boolean(),
      }),
    }),
  );

  const SetWorkspaceProviderCredentialRequestSchema = registry.register(
    "SetWorkspaceProviderCredentialRequest",
    setProviderCredentialSchema,
  );

  const WebhookDestinationSchema = registry.register(
    "WebhookDestination",
    z.object({
      id: z.string(),
      name: z.string(),
      url: z.string(),
      lastDeliveryStatus: z.enum(webhookDeliveryOutcomeStatuses).nullable(),
      lastDeliveryAt: z.string().datetime().nullable(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const WebhookDestinationListResponseSchema = registry.register(
    "WebhookDestinationListResponse",
    z.object({
      destinations: z.array(WebhookDestinationSchema),
    }),
  );

  const WebhookDestinationResponseSchema = registry.register(
    "WebhookDestinationResponse",
    z.object({
      destination: WebhookDestinationSchema,
    }),
  );

  const WebhookDestinationCreateResponseSchema = registry.register(
    "WebhookDestinationCreateResponse",
    z.object({
      destination: WebhookDestinationSchema,
      secret: z.string(),
    }),
  );

  const WebhookDestinationRequestSchema = registry.register(
    "WebhookDestinationRequest",
    webhookDestinationBodySchema,
  );

  const WebhookDestinationParamsSchema = registry.register(
    "WebhookDestinationParams",
    webhookDestinationIdParamSchema,
  );

  const WorkspaceLlmCapabilityPreferenceSchema = registry.register(
    "WorkspaceLlmCapabilityPreference",
    z.object({
      provider: z.enum(workspaceLlmProviderNames),
      model: z.string(),
    }).nullable(),
  );

  const WorkspaceLlmModelsResponseSchema = registry.register(
    "WorkspaceLlmModelsResponse",
    z.object({
      chat: WorkspaceLlmCapabilityPreferenceSchema,
      rewrite: WorkspaceLlmCapabilityPreferenceSchema,
      rerank: WorkspaceLlmCapabilityPreferenceSchema,
      knownModelsByProvider: z.object({
        openai: z.array(z.string()),
        "openai-compatible": z.array(z.string()),
        gemini: z.array(z.string()),
        claude: z.array(z.string()),
      }),
    }),
  );

  const UpdateWorkspaceLlmModelsRequestSchema = registry.register(
    "UpdateWorkspaceLlmModelsRequest",
    updateWorkspaceLlmModelsSchema,
  );

  Object.assign(schemas, {
    RetrievalDefaultsResponseSchema,
    IngestionSettingsSchema,
    UpdateIngestionSettingsRequestSchema,
    ReprocessIngestionRequestSchema,
    RetrievalMetadataRuleSchema,
    TriggerAnalysisRuleSchema,
    TriggerAnalysisSchema,
    TriggerBackoffSchema,
    UpdateGeneralSettingsRequestSchema,
    GeneralSettingsResponseSchema,
    AssistantLogoUploadRequestSchema,
    AssistantSettingsSectionSchema,
    PlatformChannelsSettingsSectionSchema,
    AgentLogoSchema,
    PlatformSettingsResponseSchema,
    UpdatePlatformSettingsRequestSchema,
    WorkspaceProviderCredentialSummarySchema,
    WorkspaceProviderCredentialsResponseSchema,
    SetWorkspaceProviderCredentialRequestSchema,
    WebhookDestinationSchema,
    WebhookDestinationListResponseSchema,
    WebhookDestinationResponseSchema,
    WebhookDestinationCreateResponseSchema,
    WebhookDestinationRequestSchema,
    WebhookDestinationParamsSchema,
    WorkspaceLlmCapabilityPreferenceSchema,
    WorkspaceLlmModelsResponseSchema,
    UpdateWorkspaceLlmModelsRequestSchema,
  });
};
