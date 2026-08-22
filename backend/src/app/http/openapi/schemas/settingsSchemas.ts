import { z } from "zod";
import { documentTypeFieldValueTypes } from "../../../../modules/documentTypes/contracts/documentTypeCatalog.js";
import {
  reprocessIngestionBodySchema,
  documentedUpdateIngestionSettingsSchema,
  documentedUpdateDocumentTypeCatalogSchema,
  updateGeneralSettingsSchema,
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
import {
  embeddingModelIds,
  manualDocumentEnrichmentOverrides,
} from "../../../../modules/settings/contracts/ingestion.js";
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
      embeddingModel: z.string().openapi({
        description:
          "The embedding model currently used for document indexing and retrieval.",
      }),
      pendingEmbeddingModel: z.enum(embeddingModelIds).nullable(),
      supportedEmbeddingModels: z.array(z.enum(embeddingModelIds)),
      fixedWindowChunkSize: z.number().int(),
      fixedWindowChunkOverlap: z.number().int(),
      structuredMinChunkSize: z.number().int(),
      structuredMaxChunkSize: z.number().int(),
      documentEnrichmentEnabled: z.boolean(),
      manualDocumentEnrichmentOverride: z.enum(manualDocumentEnrichmentOverrides).openapi({
        description:
          "Metadata extraction override for documents added by hand, which have no source of their own. 'inherit' follows documentEnrichmentEnabled.",
      }),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const EmbeddingCoverageSchema = registry.register(
    "EmbeddingCoverage",
    z.object({
      eligibleChunks: z.number().int().openapi({
        description:
          "Chunks in documents retrieval serves: ready, retrieval-enabled and unexpired.",
      }),
      coveredChunks: z.number().int().openapi({
        description:
          "Of those, the chunks that have an embedding for the workspace's current model.",
      }),
      missingChunks: z.number().int(),
      hasEmbeddingProfile: z.boolean().openapi({
        description:
          "False when the workspace has no embedding model set, which is what leaves"
          + " missing chunks unrepairable.",
      }),
      queuedJobs: z.number().int().openapi({
        description:
          "Embedding work still in flight for the current model. Counts only jobs that"
          + " would close part of the gap, so a queue draining down to zero means"
          + " indexing is finishing rather than stalling.",
      }),
      failedJobs: z.number().int().openapi({
        description:
          "Embedding jobs for the current model that exhausted their attempts. These"
          + " hold their job key, so the chunks behind them stay missing until the"
          + " failures are resolved. Jobs left by a superseded model are not counted,"
          + " because no re-run will ever move them.",
      }),
    }),
  );

  const UpdateIngestionSettingsRequestSchema = registry.register(
    "UpdateIngestionSettingsRequest",
    documentedUpdateIngestionSettingsSchema,
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

  const DocumentTypeFieldSchema = registry.register(
    "DocumentTypeField",
    z.object({
      key: z.string().openapi({
        description:
          "Metadata key this field writes. Matches ^[A-Za-z][A-Za-z0-9_]{0,63}$; dots are prohibited because metadata rules read them as path separators.",
      }),
      label: z.string(),
      valueType: z.enum(documentTypeFieldValueTypes),
      instruction: z.string().openapi({
        description: "Natural-language guidance the classification prompt carries for this field.",
      }),
    }),
  );

  const DocumentTypeDefinitionSchema = registry.register(
    "DocumentTypeDefinition",
    z.object({
      key: z.string(),
      label: z.string(),
      description: z.string(),
      enabled: z.boolean(),
      origin: z.enum(["built_in", "operator"]).openapi({
        description: "Built-in entries are system-owned and read-only.",
      }),
      payload: z.enum(["facts", "fields", "none"]).openapi({
        description:
          "Which payload extraction returns for this type: temporal facts for the built-in dated types, an ordered fields array for operator types, nothing for classification-only types.",
      }),
      disableable: z.boolean().openapi({
        description: "False for the reserved 'generic' fallback, which is always present and always enabled.",
      }),
      fields: z.array(DocumentTypeFieldSchema),
    }),
  );

  const RetiredDocumentTypeFieldSchema = registry.register(
    "RetiredDocumentTypeField",
    z.object({
      key: z.string(),
      valueType: z.enum(documentTypeFieldValueTypes),
    }).openapi({
      description:
        "A deleted field identity. A retired key can only be recreated with its original value type, so a saved retrieval rule is never re-pointed at a differently typed field.",
    }),
  );

  const DocumentTypeCatalogSchema = registry.register(
    "DocumentTypeCatalog",
    z.object({
      workspaceId: z.string().uuid(),
      revision: z.string().openapi({
        description: "Monotonically increasing concurrency token. Echo it as expectedRevision on the next write.",
      }),
      types: z.array(DocumentTypeDefinitionSchema).openapi({
        description: "Built-in entries first, then operator-defined types.",
      }),
      retiredFields: z.array(RetiredDocumentTypeFieldSchema),
      referencedFieldKeys: z.array(z.string()).openapi({
        description:
          "Field keys any agent's retrieval metadata rules currently reference. Advisory: deleting one of these fields, or disabling the type that declares it, warns rather than blocks.",
      }),
    }),
  );

  const UpdateDocumentTypeCatalogRequestSchema = registry.register(
    "UpdateDocumentTypeCatalogRequest",
    documentedUpdateDocumentTypeCatalogSchema,
  );

  Object.assign(schemas, {
    RetrievalDefaultsResponseSchema,
    IngestionSettingsSchema,
    DocumentTypeFieldSchema,
    DocumentTypeDefinitionSchema,
    RetiredDocumentTypeFieldSchema,
    DocumentTypeCatalogSchema,
    UpdateDocumentTypeCatalogRequestSchema,
    EmbeddingCoverageSchema,
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
