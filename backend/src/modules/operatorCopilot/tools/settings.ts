import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";
import { boundPayload } from "../payloadCompaction.js";

export interface CopilotWorkspaceSettingsPort {
  getRetrievalDefaults(workspaceId: string): Promise<{
    queryRewriteEnabled: boolean;
    temporalStructuredLookupEnabled?: boolean;
    temporalBoostUpcomingEnabled?: boolean;
    temporalDeterministicSortEnabled?: boolean;
    semanticRewriteInstructions: string;
    lexicalRewriteInstructions: string;
    suggestedQuestionsEnabled: boolean;
    suggestedQuestionsCount: number;
    rerankEnabled: boolean;
    vectorTopK: number;
    similarityThreshold: number;
    rerankTopK: number;
    retrievalStrategy?: string;
    customInstruction: string;
    metadataRules: ReadonlyArray<{
      id: string;
      field: string;
      valueType: string;
      operator: string;
      combinator?: string;
      effect: string;
      enabled: boolean;
      triggerMode: string;
    }>;
  }>;
  getIngestionSettings(workspaceId: string): Promise<{
    chunkingStrategy: string;
    fixedWindowChunkSize: number;
    fixedWindowChunkOverlap: number;
    structuredMinChunkSize: number;
    structuredMaxChunkSize: number;
    embeddingModel: string;
    pendingEmbeddingModel: string | null;
    documentEnrichmentEnabled?: boolean;
    manualDocumentEnrichmentOverride?: "inherit" | "on" | "off";
  }>;
  listLlmModels(workspaceId: string): Promise<ReadonlyArray<{
    capability: "chat" | "rewrite" | "rerank";
    provider: string;
    model: string;
  }>>;
  getProviderCredentialHealth(workspaceId: string): Promise<{
    encryptionConfigured: boolean;
    credentials: ReadonlyArray<{ provider: string; updatedAt: Date }>;
    envProviderAvailability: {
      openai: boolean;
      "openai-compatible": boolean;
      gemini: boolean;
      claude: boolean;
    };
  }>;
  getGeneralSettings(workspaceId: string): Promise<{
    assistant: {
      assistantName: string;
      greetingInstruction: string;
      assistantDefaultLocale: string | null;
      proactiveGreetingEnabled: boolean;
      assistantBootstrapActive: boolean;
      suggestedQuestionsEnabled: boolean;
      customInstruction: string;
    };
    channels: {
      anonymousChatEnabled: boolean;
      anonymousChatLastUsedAt: string | null;
      websiteEmbedEnabled: boolean;
      websiteEmbedLastUsedAt: string | null;
      websiteEmbedScriptUrl: string | null;
      websiteEmbedAllowedOrigins: ReadonlyArray<string>;
      websiteEmbedLauncherLabel: string;
      websiteEmbedLauncherPosition: string;
    };
  }>;
}

const workspaceSettingsInputSchema = z.object({}).strict();
const workspaceSettingsOutputSchema = z.object({
  retrieval: z.object({
    queryRewriteEnabled: z.boolean(),
    temporalStructuredLookupEnabled: z.boolean(),
    temporalBoostUpcomingEnabled: z.boolean(),
    temporalDeterministicSortEnabled: z.boolean(),
    semanticRewriteInstructions: z.string(),
    lexicalRewriteInstructions: z.string(),
    suggestedQuestionsEnabled: z.boolean(),
    suggestedQuestionsCount: z.number().int().nonnegative(),
    rerankEnabled: z.boolean(),
    vectorTopK: z.number().int().nonnegative(),
    similarityThreshold: z.number(),
    rerankTopK: z.number().int().nonnegative(),
    retrievalStrategy: z.string().nullable(),
    customInstruction: z.string(),
    metadataRules: z.array(z.object({
      id: z.string(),
      field: z.string(),
      valueType: z.string(),
      operator: z.string(),
      combinator: z.string().nullable(),
      effect: z.string(),
      enabled: z.boolean(),
      triggerMode: z.string(),
    }).strict()),
  }).strict(),
  ingestion: z.object({
    chunkingStrategy: z.string(),
    fixedWindowChunkSize: z.number().int().nonnegative(),
    fixedWindowChunkOverlap: z.number().int().nonnegative(),
    structuredMinChunkSize: z.number().int().nonnegative(),
    structuredMaxChunkSize: z.number().int().nonnegative(),
    embeddingModel: z.string(),
    pendingEmbeddingModel: z.string().nullable(),
    documentEnrichmentEnabled: z.boolean(),
    manualDocumentEnrichmentOverride: z.enum(["inherit", "on", "off"]),
  }).strict(),
  llmModels: z.object({
    chat: z.object({ provider: z.string(), model: z.string() }).strict().nullable(),
    rewrite: z.object({ provider: z.string(), model: z.string() }).strict().nullable(),
    rerank: z.object({ provider: z.string(), model: z.string() }).strict().nullable(),
  }).strict(),
  credentials: z.object({
    encryptionConfigured: z.boolean(),
    configuredProviders: z.array(z.object({ provider: z.string(), updatedAt: z.string() }).strict()),
    envProviderAvailability: z.object({
      openai: z.boolean(),
      "openai-compatible": z.boolean(),
      gemini: z.boolean(),
      claude: z.boolean(),
    }).strict(),
  }).strict(),
  general: z.object({
    assistant: z.object({
      assistantName: z.string(),
      greetingInstruction: z.string(),
      assistantDefaultLocale: z.string().nullable(),
      proactiveGreetingEnabled: z.boolean(),
      assistantBootstrapActive: z.boolean(),
      suggestedQuestionsEnabled: z.boolean(),
      customInstruction: z.string(),
    }).strict(),
    channels: z.object({
      anonymousChatEnabled: z.boolean(),
      anonymousChatLastUsedAt: z.string().nullable(),
      websiteEmbedEnabled: z.boolean(),
      websiteEmbedLastUsedAt: z.string().nullable(),
      websiteEmbedScriptUrl: z.string().nullable(),
      websiteEmbedAllowedOrigins: z.array(z.string()),
      websiteEmbedLauncherLabel: z.string(),
      websiteEmbedLauncherPosition: z.string(),
    }).strict(),
  }).strict(),
}).strict();

export const createWorkspaceSettingsCopilotTools = (deps: {
  readonly workspaceSettings: CopilotWorkspaceSettingsPort;
}): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "workspace_settings", shape: "read", uiLabel: "Reading workspace settings", contributingModule: "settings", dashboardSubject: { type: "workspace_settings" }, requiredPermission: "workspace.settings.read",
    description: "Read safe workspace retrieval, ingestion, model, credential-health, and general configuration. Tokens, secrets, credential values, and connection strings are excluded.",
    inputSchema: workspaceSettingsInputSchema, outputSchema: workspaceSettingsOutputSchema,
    createTool: (context) => ({
      name: "workspace_settings",
      description: "Read safe workspace retrieval, ingestion, model, credential-health, and general configuration. Tokens, secrets, credential values, and connection strings are excluded.",
      inputSchema: workspaceSettingsInputSchema,
      outputSchema: workspaceSettingsOutputSchema,
      invoke: async () => {
        const [retrieval, ingestion, preferences, credentialHealth, general] = await Promise.all([
          deps.workspaceSettings.getRetrievalDefaults(context.workspaceId),
          deps.workspaceSettings.getIngestionSettings(context.workspaceId),
          deps.workspaceSettings.listLlmModels(context.workspaceId),
          deps.workspaceSettings.getProviderCredentialHealth(context.workspaceId),
          deps.workspaceSettings.getGeneralSettings(context.workspaceId),
        ]);
        const preferencesByCapability = new Map(preferences.map((preference) => [
          preference.capability,
          { provider: preference.provider, model: preference.model },
        ]));

        // Do not spread values from settings services. Some settings endpoints
        // intentionally include public-channel tokens and future additions must
        // remain outside the MCP/model boundary by default.
        return boundPayload({
          retrieval: {
            queryRewriteEnabled: retrieval.queryRewriteEnabled,
            temporalStructuredLookupEnabled: retrieval.temporalStructuredLookupEnabled ?? true,
            temporalBoostUpcomingEnabled: retrieval.temporalBoostUpcomingEnabled ?? true,
            temporalDeterministicSortEnabled: retrieval.temporalDeterministicSortEnabled ?? true,
            semanticRewriteInstructions: retrieval.semanticRewriteInstructions,
            lexicalRewriteInstructions: retrieval.lexicalRewriteInstructions,
            suggestedQuestionsEnabled: retrieval.suggestedQuestionsEnabled,
            suggestedQuestionsCount: retrieval.suggestedQuestionsCount,
            rerankEnabled: retrieval.rerankEnabled,
            vectorTopK: retrieval.vectorTopK,
            similarityThreshold: retrieval.similarityThreshold,
            rerankTopK: retrieval.rerankTopK,
            retrievalStrategy: retrieval.retrievalStrategy ?? null,
            customInstruction: retrieval.customInstruction,
            metadataRules: retrieval.metadataRules.map((rule) => ({
              id: rule.id,
              field: rule.field,
              valueType: rule.valueType,
              operator: rule.operator,
              combinator: rule.combinator ?? null,
              effect: rule.effect,
              enabled: rule.enabled,
              triggerMode: rule.triggerMode,
            })),
          },
          ingestion: {
            chunkingStrategy: ingestion.chunkingStrategy,
            fixedWindowChunkSize: ingestion.fixedWindowChunkSize,
            fixedWindowChunkOverlap: ingestion.fixedWindowChunkOverlap,
            structuredMinChunkSize: ingestion.structuredMinChunkSize,
            structuredMaxChunkSize: ingestion.structuredMaxChunkSize,
            embeddingModel: ingestion.embeddingModel,
            pendingEmbeddingModel: ingestion.pendingEmbeddingModel,
            documentEnrichmentEnabled: ingestion.documentEnrichmentEnabled ?? false,
            manualDocumentEnrichmentOverride: ingestion.manualDocumentEnrichmentOverride ?? "inherit",
          },
          llmModels: {
            chat: preferencesByCapability.get("chat") ?? null,
            rewrite: preferencesByCapability.get("rewrite") ?? null,
            rerank: preferencesByCapability.get("rerank") ?? null,
          },
          credentials: {
            encryptionConfigured: credentialHealth.encryptionConfigured,
            configuredProviders: credentialHealth.credentials.map((credential) => ({
              provider: credential.provider,
              updatedAt: credential.updatedAt.toISOString(),
            })),
            envProviderAvailability: {
              openai: credentialHealth.envProviderAvailability.openai,
              "openai-compatible": credentialHealth.envProviderAvailability["openai-compatible"],
              gemini: credentialHealth.envProviderAvailability.gemini,
              claude: credentialHealth.envProviderAvailability.claude,
            },
          },
          general: {
            assistant: {
              assistantName: general.assistant.assistantName,
              greetingInstruction: general.assistant.greetingInstruction,
              assistantDefaultLocale: general.assistant.assistantDefaultLocale,
              proactiveGreetingEnabled: general.assistant.proactiveGreetingEnabled,
              assistantBootstrapActive: general.assistant.assistantBootstrapActive,
              suggestedQuestionsEnabled: general.assistant.suggestedQuestionsEnabled,
              customInstruction: general.assistant.customInstruction,
            },
            channels: {
              anonymousChatEnabled: general.channels.anonymousChatEnabled,
              anonymousChatLastUsedAt: general.channels.anonymousChatLastUsedAt,
              websiteEmbedEnabled: general.channels.websiteEmbedEnabled,
              websiteEmbedLastUsedAt: general.channels.websiteEmbedLastUsedAt,
              websiteEmbedScriptUrl: general.channels.websiteEmbedScriptUrl,
              websiteEmbedAllowedOrigins: [...general.channels.websiteEmbedAllowedOrigins],
              websiteEmbedLauncherLabel: general.channels.websiteEmbedLauncherLabel,
              websiteEmbedLauncherPosition: general.channels.websiteEmbedLauncherPosition,
            },
          },
        }) as z.infer<typeof workspaceSettingsOutputSchema>;
      },
    }),
  },
];
