import { z } from "zod";

import { serializeAgentConfig, type AgentConfig, type AgentService } from "../agents/public.js";
import { builtInAnswerDirectiveViews, type BuiltInDirectiveView } from "../directives/public.js";
import {
  projectRoutineToPortableDocument,
  type RoutineDefinition,
  type RoutineDefinitionService,
} from "../routines/public.js";
import type {
  CopilotAgentSettingProposalAdapter,
  CopilotAuditPort,
  CopilotDirectiveProposalAdapter,
  CopilotEntityDescription,
  CopilotRoutineProposalAdapter,
  CopilotProposal,
  CopilotToolDescriptor,
} from "./contracts.js";
import type { CopilotRepositoryPort } from "./service.js";
import { boundConversationPayload, boundPayload, boundTurnTracePayload } from "./boundedPayload.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);
const unknownRecord = z.record(z.unknown());
const optionalAgentInput = z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional() });
const agentConfigurationInputSchema = z.object({
  mode: z.enum(["auto", "list", "detail"]).optional(),
  agentId: idSchema.optional(),
  agentName: entityNameSchema.optional(),
  directiveId: idSchema.optional(),
}).strict();
const routineDefinitionInputSchema = z.object({
  agentId: idSchema.optional(),
  agentName: entityNameSchema.optional(),
  routineId: idSchema.optional(),
  routineTitle: entityNameSchema.optional(),
});
const agentConfigurationOutputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("list"),
    agentCount: z.number().int().nonnegative(),
    agentsTruncated: z.boolean(),
    agents: z.array(unknownRecord),
    agent: z.null(),
  }),
  z.object({
    mode: z.literal("detail"),
    agentCount: z.null(),
    agentsTruncated: z.null(),
    agents: z.array(unknownRecord).max(0),
    agent: unknownRecord,
  }),
]);
const routineDefinitionOutputSchema = z.object({
  routineCount: z.number().int().nonnegative(),
  routinesTruncated: z.boolean(),
  routine: unknownRecord.nullable(),
  routines: z.array(unknownRecord),
});
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));
const truncationSchema = z.object({
  truncated: z.literal(true),
  entries: z.array(z.object({
    path: z.string(),
    reason: z.enum(["string_length", "array_length", "budget_omitted"]),
    originalLength: z.number().int().nonnegative().optional(),
    retainedLength: z.number().int().nonnegative().optional(),
  })),
});
const shallowRouteSchema = z.object({
  generator: z.string(),
  routeType: z.enum(["direct", "retrieval"]),
  routeReason: z.string(),
  retrievalInvoked: z.boolean(),
}).nullable();
const turnFailureSchema = z.object({
  eventStatus: z.enum(["failure", "cancelled"]),
  recordedAt: z.string(),
  stream: z.boolean(),
  stage: z.string().optional(),
  errorMessage: z.string().nullable().optional(),
}).nullable();
const ownershipSchema = z.object({
  conversationId: z.string().uuid(),
  state: z.literal("human_owned"),
  ownerDisplayName: z.string().nullable(),
  reason: z.string().nullable(),
  takenOverAt: z.string().nullable(),
}).nullable();
const transcriptMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["user", "assistant", "system"]),
  source: z.string(),
  content: z.string(),
  createdAt: z.string(),
  answerOutcome: z.string().nullable(),
  route: shallowRouteSchema,
  skill: z.object({ name: z.string(), outcome: z.string(), status: z.string() }).nullable(),
  citationCount: z.number().int().nonnegative(),
  latencyMs: z.number().nonnegative().nullable(),
  answerFeedback: z.array(jsonValueSchema),
  operatorDisplayName: z.string().nullable(),
  turnFailure: turnFailureSchema,
});
const conversationTranscriptOutputSchema = z.object({
  transcript: z.object({
    conversationId: z.string().uuid(),
    agentId: z.string().uuid().nullable(),
    agentName: z.string().nullable(),
    sourceChannel: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    messageCount: z.number().int().nonnegative(),
    ownership: ownershipSchema,
    messages: z.array(transcriptMessageSchema),
  }).and(z.object({ truncation: truncationSchema.optional() })),
});
const traceStageSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  inputs: z.record(jsonValueSchema).optional(),
  outputs: z.record(jsonValueSchema).optional(),
  subTrace: jsonValueSchema.optional(),
}).passthrough();
const turnTraceEnvelopeSchema = z.object({
  version: z.number().int().nonnegative(),
  spine: z.object({
    traceId: z.string(),
    startedAt: z.string(),
    completedAt: z.string().optional(),
    stages: z.array(traceStageSchema),
  }).passthrough(),
  openTelemetry: z.object({ traceId: z.string(), spanId: z.string(), sampled: z.boolean() }).optional(),
  summary: z.record(jsonValueSchema).optional(),
}).nullable();
const turnTraceOutputSchema = z.object({
  trace: z.object({
    conversationId: z.string().uuid(),
    ownership: ownershipSchema,
    message: z.object({
      id: z.string().uuid(),
      role: z.enum(["user", "assistant", "system"]),
      source: z.string(),
      content: z.string(),
      createdAt: z.string(),
      citations: z.array(jsonValueSchema),
      answerFeedback: z.array(jsonValueSchema),
      operatorDisplayName: z.string().nullable(),
      turnFailure: turnFailureSchema,
      debug: z.object({
        eventStatus: z.enum(["success", "failure", "cancelled"]),
        recordedAt: z.string(),
        stream: z.boolean(),
        citationCount: z.number().int().nonnegative(),
        answerOutcome: z.string().nullable(),
        skill: z.object({ name: z.string(), outcome: z.string(), status: z.string() }).nullable(),
        route: shallowRouteSchema,
        activitySummary: jsonValueSchema.nullable(),
        activityTrace: jsonValueSchema.nullable(),
        turnTrace: turnTraceEnvelopeSchema,
        errorMessage: z.string().nullable(),
      }).nullable(),
    }),
  }).and(z.object({ truncation: truncationSchema.optional() })),
});

const copilotAgentListLimit = 40;
const copilotDirectiveListLimit = 40;
const copilotBuiltInDirectiveListLimit = 20;
const copilotBuiltInDirectiveActionCharLimit = 8_000;
const copilotBuiltInDirectiveTotalActionCharBudget = 20_000;
const copilotDirectiveDetailCollectionLimit = 10;
const copilotDirectiveMetadataCharLimit = 4_000;
const copilotDirectiveDetailCharBudget = 24_000;
const copilotRoutineListLimit = 40;
const copilotRoutineContentCharLimit = 20_000;

/**
 * Narrow ports over other modules' public services. The copilot owns these
 * consumer-shaped contracts so it never imports another module's internals.
 */
export interface CopilotConversationHistoryPort {
  getConversation(workspaceId: string, conversationId: string, options: { limit: number }, debug: CopilotConversationOptions): Promise<CopilotConversationDetail>;
  getConversationTurn(workspaceId: string, messageId: string, options: CopilotConversationOptions): Promise<CopilotConversationTurnDetail>;
  listConversations(workspaceId: string, options: { limit: number }): Promise<{ conversations: ReadonlyArray<unknown> }>;
}

interface CopilotConversationOptions {
  includeAnswerFeedback: boolean;
  includeOwnership: boolean;
  includeTurnFailureDebug: boolean;
}

interface CopilotOwnership {
  conversationId: string;
  state: "human_owned" | "ai_owned";
  ownerDisplayName: string | null;
  reason: string | null;
  takenOverAt: string | null;
}

interface CopilotTurnFailure {
  eventStatus: "failure" | "cancelled";
  recordedAt: string;
  stream: boolean;
  stage?: string;
  errorMessage?: string | null;
}

interface CopilotDebug {
  eventStatus: "success" | "failure" | "cancelled";
  recordedAt: string;
  stream: boolean;
  citationCount: number;
  answerOutcome?: string;
  skillName?: string;
  skillOutcome?: string;
  skillStatus?: string;
  activitySummary?: unknown;
  activityTrace?: unknown;
  turnTrace?: unknown;
  errorMessage?: string | null;
  route?: { generator: string; routeType: "direct" | "retrieval"; routeReason: string; retrievalInvoked: boolean };
}

interface CopilotConversationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  source: string;
  content: string;
  createdAt: string;
  citations?: ReadonlyArray<unknown>;
  answerFeedbackEntries?: ReadonlyArray<unknown>;
  latencyMs?: number;
  operatorDisplayName?: string;
  turnFailure?: CopilotTurnFailure;
  debug?: CopilotDebug;
}

interface CopilotConversationDetail {
  conversationId: string;
  agentId: string | null;
  agentName: string | null;
  sourceChannel: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  ownership?: CopilotOwnership;
  messages: ReadonlyArray<CopilotConversationMessage>;
}

interface CopilotConversationTurnDetail {
  conversationId: string;
  ownership?: CopilotOwnership;
  message: CopilotConversationMessage;
}

const projectOwnership = (ownership: CopilotOwnership | undefined) => ownership
  && ownership.state === "human_owned"
  ? {
      conversationId: ownership.conversationId,
      state: ownership.state,
      ownerDisplayName: ownership.ownerDisplayName,
      reason: ownership.reason,
      takenOverAt: ownership.takenOverAt,
    }
  : null;

const projectTurnFailure = (turnFailure: CopilotTurnFailure | undefined) => turnFailure
  ? {
      eventStatus: turnFailure.eventStatus,
      recordedAt: turnFailure.recordedAt,
      stream: turnFailure.stream,
      ...(turnFailure.stage ? { stage: turnFailure.stage } : {}),
      ...(turnFailure.errorMessage !== undefined ? { errorMessage: turnFailure.errorMessage } : {}),
    }
  : null;

const projectSkill = (debug: CopilotDebug | undefined) =>
  debug?.skillName && debug.skillOutcome && debug.skillStatus
    ? { name: debug.skillName, outcome: debug.skillOutcome, status: debug.skillStatus }
    : null;

const projectTranscript = (conversation: CopilotConversationDetail): Record<string, unknown> => ({
  conversationId: conversation.conversationId,
  agentId: conversation.agentId,
  agentName: conversation.agentName,
  sourceChannel: conversation.sourceChannel,
  createdAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
  messageCount: conversation.messageCount,
  ownership: projectOwnership(conversation.ownership),
  messages: conversation.messages.map((message) => ({
    id: message.id,
    role: message.role,
    source: message.source,
    content: message.content,
    createdAt: message.createdAt,
    answerOutcome: message.debug?.answerOutcome ?? null,
    route: message.debug?.route ?? null,
    skill: projectSkill(message.debug),
    citationCount: message.debug?.citationCount ?? message.citations?.length ?? 0,
    latencyMs: message.latencyMs ?? null,
    answerFeedback: [...(message.answerFeedbackEntries ?? [])],
    operatorDisplayName: message.operatorDisplayName ?? null,
    turnFailure: projectTurnFailure(message.turnFailure),
  })),
});

const projectTurnTrace = (detail: CopilotConversationTurnDetail): Record<string, unknown> => {
  const { message } = detail;
  const debug = message.debug;
  return {
    conversationId: detail.conversationId,
    ownership: projectOwnership(detail.ownership),
    message: {
      id: message.id,
      role: message.role,
      source: message.source,
      content: message.content,
      createdAt: message.createdAt,
      citations: [...(message.citations ?? [])],
      answerFeedback: [...(message.answerFeedbackEntries ?? [])],
      operatorDisplayName: message.operatorDisplayName ?? null,
      turnFailure: projectTurnFailure(message.turnFailure),
      debug: debug
        ? {
            eventStatus: debug.eventStatus,
            recordedAt: debug.recordedAt,
            stream: debug.stream,
            citationCount: debug.citationCount,
            answerOutcome: debug.answerOutcome ?? null,
            skill: projectSkill(debug),
            route: debug.route ?? null,
            activitySummary: debug.activitySummary ?? null,
            activityTrace: debug.activityTrace ?? null,
            turnTrace: debug.turnTrace ?? null,
            errorMessage: debug.errorMessage ?? null,
          }
        : null,
    },
  };
};

export interface CopilotDocumentSearchPort {
  search(input: { workspaceId: string; query: string; executionSurface: "operator_copilot" }): Promise<{ results: ReadonlyArray<unknown> }>;
}

export interface CopilotEvalResultsPort {
  listWithLatestRun(workspaceId: string): Promise<ReadonlyArray<object>>;
}

export interface CopilotQualitySignalsPort {
  getQualityStats(workspaceId: string, input: { range: "30d"; agentId?: string }): Promise<object>;
  listLowQualityTurns(workspaceId: string, input: { limit: number; agentId?: string }): Promise<{ items: ReadonlyArray<object> }>;
}

export interface CopilotAudiencePulsePort {
  read(input: { accountId: string; userId: string; workspaceId: string }): Promise<object>;
}

export interface CopilotDocumentStatusPort {
  summarizeWorkspace(workspaceId: string): Promise<{
    documentCount: number;
    readyDocumentCount: number;
    pendingDocumentCount: number;
    failedDocumentCount: number;
  }>;
  listByStatuses(workspaceId: string, statuses: ReadonlyArray<string>, input: { limit: number }): Promise<ReadonlyArray<{
    id: string;
    title: string;
    status: string;
    failureReason?: string | null;
    updatedAt: Date;
    sourceId?: string | null;
  }>>;
}

export interface CopilotDocumentSourceStatusPort {
  listByWorkspaceIdWithDocumentCounts(workspaceId: string): Promise<ReadonlyArray<{
    id: string;
    kind: string;
    name: string;
    lastSyncStatus: string | null;
    lastSyncedAt: Date | null;
    documentCount: number;
  }>>;
}

export interface CopilotAgentSkillsPort {
  list(workspaceId: string, agentId: string): Promise<ReadonlyArray<{
    name: string;
    capability: string;
    target: { kind: string | null; id: string | null };
    config: Record<string, unknown>;
    invocationMode: string;
    enabled: boolean;
  }>>;
}

export interface CopilotSkillCapabilityTargetsPort {
  list(): ReadonlyArray<{
    id: string;
    targetKind: string;
    requiresTarget?: boolean;
    enumerateTargets(context: { workspaceId: string; agentId: string }): Promise<ReadonlyArray<{ id: string; label: string; status?: string }>>;
  }>;
}

/**
 * Consumer-shaped workspace configuration port. Its source services remain
 * outside the copilot module; the reader still projects every field it emits
 * so a future source addition cannot enter a model context by accident.
 */
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
    name: "workspace_settings", shape: "read", uiLabel: "Reading workspace settings", contributingModule: "settings", requiredPermission: "workspace.settings.read",
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

export const createUs1CopilotTools = (deps: {
  readonly agentService: Pick<AgentService, "listExisting" | "resolve">;
  readonly routineDefinitionService: Pick<RoutineDefinitionService, "list" | "get">;
  readonly chatHistoryService: CopilotConversationHistoryPort;
  readonly documentSearchService: CopilotDocumentSearchPort;
}): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "agent_configuration", shape: "read", uiLabel: "Reading agent configuration", contributingModule: "agents", requiredPermission: "workspace.agents.read",
    description: "List workspace agents or read one agent's redacted portable configuration. Use mode list to override page context. A directive id returns that directive in full.",
    inputSchema: agentConfigurationInputSchema, outputSchema: agentConfigurationOutputSchema,
    createTool: (context) => ({
      name: "agent_configuration",
      description: "List workspace agents or read one agent's redacted portable configuration. Use mode list to override page context. A directive id returns that directive in full.",
      inputSchema: agentConfigurationInputSchema,
      outputSchema: agentConfigurationOutputSchema,
      invoke: async ({ mode = "auto", agentId, directiveId }) => {
        if (mode === "list") {
          if (agentId || directiveId) throw new Error("Agent discovery does not accept an agent or directive id");
          const agents = await deps.agentService.listExisting(context.workspaceId);
          return {
            mode: "list" as const,
            agentCount: agents.length,
            agentsTruncated: agents.length > copilotAgentListLimit,
            agents: projectAgentSummaries(agents),
            agent: null,
          };
        }

        const resolvedAgentId = agentId ?? (mode === "detail" || directiveId
          ? requiredPageAgent(context.pageContext.agentId)
          : context.pageContext.agentId);
        if (!resolvedAgentId) {
          const agents = await deps.agentService.listExisting(context.workspaceId);
          return {
            mode: "list" as const,
            agentCount: agents.length,
            agentsTruncated: agents.length > copilotAgentListLimit,
            agents: projectAgentSummaries(agents),
            agent: null,
          };
        }

        const selectedAgent = await deps.agentService.resolve(context.workspaceId, resolvedAgentId);
        return {
          mode: "detail" as const,
          agentCount: null,
          agentsTruncated: null,
          agents: [],
          agent: projectAgentConfiguration(selectedAgent, directiveId),
        };
      },
    }),
    describeEntity: (input, context) => {
      const parsed = input as z.infer<typeof agentConfigurationInputSchema>;
      return parsed.mode === "list"
      ? null
        : parsed.agentName
          ? describeNamedAgent(parsed, context, deps.agentService)
          : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
    },
  },
  {
    name: "routine_definition", shape: "read", uiLabel: "Reading routine", contributingModule: "routines", requiredPermission: "workspace.agents.read",
    description: "List an agent's routines or read one routine in portable Markdown form.",
    inputSchema: routineDefinitionInputSchema, outputSchema: routineDefinitionOutputSchema,
    createTool: (context) => ({
      name: "routine_definition",
      description: "List an agent's routines or read one routine in portable Markdown form.",
      inputSchema: routineDefinitionInputSchema,
      outputSchema: routineDefinitionOutputSchema,
      invoke: async ({ agentId, routineId }) => {
        const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
        if (routineId) {
          const routine = await deps.routineDefinitionService.get(context.workspaceId, resolvedAgentId, routineId);
          return {
            routineCount: 1,
            routinesTruncated: false,
            routine: projectRoutineDetail(routine),
            routines: [],
          };
        }
        const definitions = await deps.routineDefinitionService.list(context.workspaceId, resolvedAgentId);
        return {
          routineCount: definitions.length,
          routinesTruncated: definitions.length > copilotRoutineListLimit,
          routine: null,
          routines: definitions.slice(0, copilotRoutineListLimit).map(projectRoutineSummary),
        };
      },
    }),
    describeEntity: (input, context) => {
      const parsed = input as z.infer<typeof routineDefinitionInputSchema>;
      return parsed.agentName || parsed.routineTitle
        ? describeNamedRoutine(parsed, context, deps)
        : parsed.routineId
          ? { type: "routine", id: parsed.routineId, ...(parsed.agentId ?? context?.pageContext.agentId ? { agentId: parsed.agentId ?? context?.pageContext.agentId! } : {}) }
          : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
    },
  },
  {
    name: "conversation_transcript", shape: "read", uiLabel: "Reading conversation transcript", contributingModule: "chat", requiredPermission: "workspace.history.read",
    description: "Read a bounded customer transcript with shallow per-turn outcomes, routing, feedback, and ownership. Use turn_trace for one turn's full diagnostic spine.",
    inputSchema: z.object({ conversationId: idSchema.optional() }), outputSchema: conversationTranscriptOutputSchema,
    createTool: (context) => ({
      name: "conversation_transcript",
      description: "Read a bounded customer transcript with shallow per-turn outcomes, routing, feedback, and ownership. Use turn_trace for one turn's full diagnostic spine.",
      inputSchema: z.object({ conversationId: idSchema.optional() }),
      outputSchema: conversationTranscriptOutputSchema,
      invoke: async ({ conversationId }) => ({
        transcript: boundConversationPayload(projectTranscript(await deps.chatHistoryService.getConversation(
          context.workspaceId,
          conversationId ?? requiredPageConversation(context.pageContext.conversationId),
          { limit: 100 },
          { includeAnswerFeedback: true, includeOwnership: true, includeTurnFailureDebug: true },
        ))),
      }),
    }),
    describeEntity: ({ conversationId }, context) => entity("conversation", conversationId ?? context?.pageContext.conversationId),
  },
  {
    name: "turn_trace", shape: "read", uiLabel: "Reading turn trace", contributingModule: "chat", requiredPermission: "workspace.history.read",
    description: "Inspect one message's full turn diagnostic spine. Accepts user messages, including unanswered turns with their failure or cancellation reason.",
    inputSchema: z.object({ messageId: idSchema }), outputSchema: turnTraceOutputSchema,
    createTool: (context) => ({
      name: "turn_trace",
      description: "Inspect one message's full turn diagnostic spine. Accepts user messages, including unanswered turns with their failure or cancellation reason.",
      inputSchema: z.object({ messageId: idSchema }),
      outputSchema: turnTraceOutputSchema,
      invoke: async ({ messageId }) => ({
        trace: boundTurnTracePayload(projectTurnTrace(await deps.chatHistoryService.getConversationTurn(
          context.workspaceId,
          messageId,
          { includeAnswerFeedback: true, includeOwnership: true, includeTurnFailureDebug: true },
        ))),
      }),
    }),
  },
  {
    name: "conversation_history_search", shape: "read", uiLabel: "Searching conversations", contributingModule: "chat", requiredPermission: "workspace.history.read",
    description: "List recent customer conversations in this workspace for investigation.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ conversations: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "conversation_history_search", description: "List recent customer conversations in this workspace for investigation.", inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ conversations: z.array(unknownRecord) }), invoke: async ({ limit }) => ({ conversations: boundPayload({ conversations: (await deps.chatHistoryService.listConversations(context.workspaceId, { limit: limit ?? 20 })).conversations as Record<string, unknown>[] }).conversations as Record<string, unknown>[] }) }),
  },
  {
    name: "document_search", shape: "read", uiLabel: "Searching documents", contributingModule: "documents", requiredPermission: "workspace.documents.read",
    description: "Search workspace documents and return matching document metadata and quoted evidence snippets — the only document text available to you.",
    inputSchema: z.object({ query: z.string().min(1).max(1000) }), outputSchema: z.object({ results: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "document_search", description: "Search workspace documents and return matching document metadata and quoted evidence snippets — the only document text available to you.", inputSchema: z.object({ query: z.string().min(1).max(1000) }), outputSchema: z.object({ results: z.array(unknownRecord) }), invoke: async ({ query }) => ({ results: boundPayload({ results: (await deps.documentSearchService.search({ workspaceId: context.workspaceId, query, executionSurface: "operator_copilot" })).results as Record<string, unknown>[] }).results as Record<string, unknown>[] }) }),
  },
];

const projectAgentSummaries = (
  agents: Awaited<ReturnType<AgentService["listExisting"]>>,
) => agents.slice(0, copilotAgentListLimit).map((agent) => ({
  id: agent.id,
  name: agent.name,
  isDefault: agent.isDefault,
  assistantBootstrapActive: agent.assistantBootstrapActive,
}));

const projectAgentConfiguration = (
  agent: Awaited<ReturnType<AgentService["resolve"]>>,
  directiveId: string | undefined,
): Record<string, unknown> => {
  const serialized = serializeAgentConfig(agent);
  const { authoredDirectives: portableDirectives, ...portableAgent } = serialized;
  const directives = agent.authoredDirectives ?? [];
  const selectedIndex = directiveId
    ? directives.findIndex((directive) => directive.id === directiveId)
    : -1;
  if (directiveId && selectedIndex < 0) throw new Error("Directive not found");

  const visibleIndexes = Array.from(
    { length: Math.min(directives.length, copilotDirectiveListLimit) },
    (_, index) => index,
  );
  if (selectedIndex >= copilotDirectiveListLimit) {
    visibleIndexes[visibleIndexes.length - 1] = selectedIndex;
  }

  return {
    id: agent.id,
    ...boundPayload(portableAgent as unknown as Record<string, unknown>),
    authoredDirectives: visibleIndexes.map((index) => ({
      id: directives[index]!.id,
      name: directives[index]!.name,
      priority: directives[index]!.priority,
      actionChars: directives[index]!.action.length,
    })),
    directiveCount: directives.length,
    directivesTruncated: directives.length > copilotDirectiveListLimit,
    directiveRefs: visibleIndexes.map((index) => ({
      id: directives[index]!.id,
      name: directives[index]!.name,
    })),
    builtInDirectiveCount: builtInAnswerDirectiveViews.length,
    builtInsTruncated: builtInAnswerDirectiveViews.length > copilotBuiltInDirectiveListLimit,
    builtIns: projectBuiltInDirectives(builtInAnswerDirectiveViews),
    directive: selectedIndex >= 0
      ? projectDirectiveDetail(directives[selectedIndex]!.id, portableDirectives[selectedIndex]!)
      : null,
  };
};

const projectBuiltInDirectives = (
  directives: ReadonlyArray<BuiltInDirectiveView>,
): ReadonlyArray<Record<string, unknown>> => {
  let remainingActionChars = copilotBuiltInDirectiveTotalActionCharBudget;
  return directives.slice(0, copilotBuiltInDirectiveListLimit).map((directive) => {
    const actionTooLarge = directive.action.length > copilotBuiltInDirectiveActionCharLimit;
    const exceedsTotalBudget = directive.action.length > remainingActionChars;
    const omittedReason = actionTooLarge
      ? "content_too_large"
      : exceedsTotalBudget ? "total_budget" : null;
    if (!omittedReason) remainingActionChars -= directive.action.length;
    const boundedIdentity = boundPayload({
      name: directive.name,
      condition: directive.condition,
      priority: directive.priority,
      description: directive.description,
    });
    return {
      ...boundedIdentity,
      action: omittedReason ? null : directive.action,
      actionChars: directive.action.length,
      omittedReason,
    };
  });
};

const directiveCollectionKeys = [
  "requiredCapabilities",
  "dependsOn",
  "excludes",
  "routes",
  "tags",
] as const satisfies ReadonlyArray<keyof AgentConfig["authoredDirectives"][number]>;

const projectDirectiveDetail = (
  id: string,
  directive: AgentConfig["authoredDirectives"][number],
): Record<string, unknown> => {
  const metadataChars = JSON.stringify(directive.metadata).length;
  const metadataOmitted = metadataChars > copilotDirectiveMetadataCharLimit;
  const truncatedCollections = directiveCollectionKeys.filter(
    (key) => directive[key].length > copilotDirectiveDetailCollectionLimit,
  );
  const boundedCollections = Object.fromEntries(directiveCollectionKeys.map((key) => [
    key,
    directive[key].slice(0, copilotDirectiveDetailCollectionLimit),
  ]));
  const projected = {
    id,
    ...directive,
    ...boundedCollections,
    metadata: metadataOmitted ? null : directive.metadata,
    detailBounds: {
      metadataOmittedReason: metadataOmitted ? "content_too_large" : null,
      truncatedCollections,
    },
  };
  const projectedChars = JSON.stringify(projected).length;
  if (projectedChars <= copilotDirectiveDetailCharBudget) return projected;

  const allPopulatedCollections = directiveCollectionKeys.filter((key) => directive[key].length > 0);
  const withoutCollections = {
    ...projected,
    ...Object.fromEntries(directiveCollectionKeys.map((key) => [key, []])),
    metadata: null,
    detailBounds: {
      metadataOmittedReason: "total_budget",
      truncatedCollections: allPopulatedCollections,
      charBudget: copilotDirectiveDetailCharBudget,
      originalChars: projectedChars,
    },
  };
  if (JSON.stringify(withoutCollections).length <= copilotDirectiveDetailCharBudget) return withoutCollections;

  return {
    id,
    name: directive.name,
    priority: directive.priority,
    action: null,
    detailBounds: {
      detailOmittedReason: "content_too_large",
      charBudget: copilotDirectiveDetailCharBudget,
      originalChars: projectedChars,
    },
  };
};

const routineIdentity = (routine: RoutineDefinition) => ({
  id: routine.id,
  name: routine.name,
  status: routine.status,
});

const projectRoutineSummary = (routine: RoutineDefinition): Record<string, unknown> => {
  const projected = projectRoutineToPortableDocument(routine);
  if (!projected.ok) {
    return { ...routineIdentity(routine), portable: projected };
  }
  return {
    ...routineIdentity(routine),
    portable: {
      ok: true,
      grammarVersion: projected.envelope.grammarVersion,
      contentChars: projected.envelope.content.length,
    },
  };
};

const projectRoutineDetail = (routine: RoutineDefinition): Record<string, unknown> => {
  const projected = projectRoutineToPortableDocument(routine);
  if (!projected.ok) {
    return { ...routineIdentity(routine), portable: projected };
  }
  const contentChars = projected.envelope.content.length;
  const contentTooLarge = contentChars > copilotRoutineContentCharLimit;
  return {
    ...routineIdentity(routine),
    portable: {
      ok: true,
      grammarVersion: projected.envelope.grammarVersion,
      content: contentTooLarge ? null : projected.envelope.content,
      contentChars,
      omittedReason: contentTooLarge ? "content_too_large" : null,
    },
  };
};

export const createUs2CopilotTools = (deps: {
  readonly agentService?: Pick<AgentService, "listExisting">;
  readonly evalResultsService: CopilotEvalResultsPort;
  readonly qualitySignalsService: CopilotQualitySignalsPort;
  readonly audiencePulseService: CopilotAudiencePulsePort;
}): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "eval_results", shape: "read", uiLabel: "Reading eval results", contributingModule: "eval", requiredPermission: "workspace.retrieval.query",
    description: "Read recent evaluation cases and their latest outcomes for an agent.",
    inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ cases: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "eval_results", description: "Read recent evaluation cases and their latest outcomes for an agent.", inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ cases: z.array(unknownRecord) }), invoke: async ({ agentId, limit }) => {
      const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
      const cases = (await deps.evalResultsService.listWithLatestRun(context.workspaceId)).map(asRecord)
        .filter((item) => agentIdForEvalCase(item) === resolvedAgentId)
        .sort((left, right) => newestEvalResultFirst(left, right))
        .slice(0, limit ?? 20);
      return boundPayload({ cases }) as { cases: Record<string, unknown>[] };
    } }),
    describeEntity: (input, context) => {
      const parsed = input as { agentId?: string; agentName?: string };
      return parsed.agentName
        ? describeNamedAgent(parsed, context, deps.agentService)
        : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
    },
  },
  {
    name: "quality_signals", shape: "read", uiLabel: "Reading quality signals", contributingModule: "quality", requiredPermission: "workspace.quality.read",
    description: "Read workspace quality and needs-attention signals.",
    inputSchema: optionalAgentInput, outputSchema: z.object({ summary: unknownRecord, needsAttention: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "quality_signals", description: "Read workspace quality and needs-attention signals.", inputSchema: optionalAgentInput, outputSchema: z.object({ summary: unknownRecord, needsAttention: z.array(unknownRecord) }), invoke: async ({ agentId }) => {
      const resolvedAgentId = agentId ?? context.pageContext.agentId ?? undefined;
      const [summary, needsAttention] = await Promise.all([
        deps.qualitySignalsService.getQualityStats(context.workspaceId, { range: "30d", ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}) }),
        deps.qualitySignalsService.listLowQualityTurns(context.workspaceId, { limit: 20, ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}) }),
      ]);
      return boundPayload({ summary: asRecord(summary), needsAttention: needsAttention.items.map(asRecord) }) as { summary: Record<string, unknown>; needsAttention: Record<string, unknown>[] };
    } }),
    describeEntity: (input, context) => {
      const parsed = input as { agentId?: string; agentName?: string };
      return parsed.agentName
        ? describeNamedAgent(parsed, context, deps.agentService)
        : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
    },
  },
  {
    name: "audience_topics", shape: "read", uiLabel: "Reading audience topics", contributingModule: "audiencePulse", requiredPermission: "workspace.quality.read",
    description: "Read the latest stored Audience Pulse topic census. This never starts a new analysis.",
    inputSchema: z.object({}), outputSchema: z.object({ result: unknownRecord }),
    createTool: (context) => ({ name: "audience_topics", description: "Read the latest stored Audience Pulse topic census. This never starts a new analysis.", inputSchema: z.object({}), outputSchema: z.object({ result: unknownRecord }), invoke: async () => boundPayload({ result: asRecord(await deps.audiencePulseService.read({ accountId: context.accountId, userId: context.operatorUserId, workspaceId: context.workspaceId })) }) }),
  },
];

const documentAttentionStatuses = ["failed", "queued", "processing"] as const;
const documentAttentionLimit = 25;

const documentStatusOutputSchema = z.object({
  counts: z.object({ total: z.number(), ready: z.number(), pending: z.number(), failed: z.number() }),
  attention: z.array(unknownRecord),
  sources: z.array(unknownRecord),
});
const agentSkillsOutputSchema = z.object({ skills: z.array(unknownRecord), capabilities: z.array(unknownRecord) });

/**
 * Operability readers: how the workspace's knowledge base is processing, and what
 * an agent can actually do. Both project their source records field by field —
 * document content, document metadata values, source credentials, and skill
 * config values never reach the model.
 */
export const createUs4CopilotTools = (deps: {
  readonly agentService: Pick<AgentService, "get"> & Partial<Pick<AgentService, "listExisting">>;
  readonly documentStatusService: CopilotDocumentStatusPort;
  readonly documentSourceStatusService: CopilotDocumentSourceStatusPort;
  readonly agentSkillsService: CopilotAgentSkillsPort;
  readonly skillCapabilityRegistry: CopilotSkillCapabilityTargetsPort;
}): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "document_status", shape: "read", uiLabel: "Checking document status", contributingModule: "documents", requiredPermission: "workspace.documents.read",
    description: "Read knowledge base processing state: document counts by status, documents needing attention, and document source sync state. Returns titles, statuses, and failure reasons — never document content.",
    inputSchema: z.object({}), outputSchema: documentStatusOutputSchema,
    createTool: (context) => ({
      name: "document_status",
      description: "Read knowledge base processing state: document counts by status, documents needing attention, and document source sync state. Returns titles, statuses, and failure reasons — never document content.",
      inputSchema: z.object({}),
      outputSchema: documentStatusOutputSchema,
      invoke: async () => {
        const [summary, attention, sources] = await Promise.all([
          deps.documentStatusService.summarizeWorkspace(context.workspaceId),
          deps.documentStatusService.listByStatuses(context.workspaceId, documentAttentionStatuses, { limit: documentAttentionLimit }),
          deps.documentSourceStatusService.listByWorkspaceIdWithDocumentCounts(context.workspaceId),
        ]);
        return boundPayload({
          counts: {
            total: summary.documentCount,
            ready: summary.readyDocumentCount,
            pending: summary.pendingDocumentCount,
            failed: summary.failedDocumentCount,
          },
          attention: attention.map((document) => ({
            id: document.id,
            title: document.title,
            status: document.status,
            failureReason: document.failureReason ?? null,
            updatedAt: document.updatedAt.toISOString(),
            sourceId: document.sourceId ?? null,
          })),
          sources: sources.map((source) => ({
            id: source.id,
            kind: source.kind,
            label: source.name,
            lastSyncStatus: source.lastSyncStatus,
            lastSyncedAt: source.lastSyncedAt ? source.lastSyncedAt.toISOString() : null,
            documentCount: source.documentCount,
          })),
        }) as z.infer<typeof documentStatusOutputSchema>;
      },
    }),
  },
  {
    name: "agent_skills", shape: "read", uiLabel: "Reading agent skills", contributingModule: "agentSkills", requiredPermission: "workspace.agents.read",
    description: "Read the skills configured on an agent and which skill capabilities have a usable connection. Returns each skill's setting key names, never their values.",
    inputSchema: optionalAgentInput, outputSchema: agentSkillsOutputSchema,
    createTool: (context) => ({
      name: "agent_skills",
      description: "Read the skills configured on an agent and which skill capabilities have a usable connection. Returns each skill's setting key names, never their values.",
      inputSchema: optionalAgentInput,
      outputSchema: agentSkillsOutputSchema,
      invoke: async ({ agentId }) => {
        const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
        // Tenancy guard, and it must run first: skill targets (MCP connections,
        // external skills) are agent-scoped, so enumerating them before the agent
        // is proven to belong to this workspace would leak another tenant's
        // connections.
        await deps.agentService.get(context.workspaceId, resolvedAgentId);

        const capabilities = await Promise.all(deps.skillCapabilityRegistry.list().map(async (descriptor) => {
          const targets = await descriptor.enumerateTargets({ workspaceId: context.workspaceId, agentId: resolvedAgentId });
          const requiresTarget = descriptor.requiresTarget ?? true;
          const available = requiresTarget ? targets.length > 0 : true;
          return { id: descriptor.id, targetKind: descriptor.targetKind, requiresTarget, available, targets };
        }));
        const targetsByCapability = new Map(capabilities.map((capability) => [
          capability.id,
          new Map(capability.targets.map((target) => [target.id, target])),
        ]));
        const skills = (await deps.agentSkillsService.list(context.workspaceId, resolvedAgentId)).map((skill) => {
          const target = skill.target.id ? targetsByCapability.get(skill.capability)?.get(skill.target.id) ?? null : null;
          return {
            name: skill.name,
            capability: skill.capability,
            invocationMode: skill.invocationMode,
            enabled: skill.enabled,
            target: { kind: skill.target.kind, id: skill.target.id, label: target?.label ?? null, status: target?.status ?? null },
            // Key names only: skill config carries operator-entered payload
            // bindings, delivery addresses, and credentials.
            configKeys: Object.keys(skill.config).sort(),
          };
        });
        return boundPayload({
          skills,
          capabilities: capabilities.map(({ targets, available, ...capability }) => ({
            ...capability,
            targetCount: targets.length,
            available,
            unavailableReason: available ? null : "no_connection",
          })),
        }) as z.infer<typeof agentSkillsOutputSchema>;
      },
    }),
    describeEntity: (input, context) => {
      const parsed = input as { agentId?: string; agentName?: string };
      // This group only needs `get`, so `listExisting` is optional here. Pass the method itself
      // rather than the service: narrowing an optional property by truthiness on its parent does
      // not narrow the parent's type.
      const listExisting = deps.agentService.listExisting;
      return parsed.agentName
        ? describeNamedAgent(parsed, context, listExisting ? { listExisting } : undefined)
        : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
    },
  },
];

const proposalOutputSchema = z.object({
  proposalId: z.string().uuid(),
  targetType: z.enum(["directive", "agent_setting", "routine"]),
  targetLabel: z.string(),
  summary: z.string(),
});

export const createUs3CopilotTools = (deps: {
  readonly agentService?: Pick<AgentService, "listExisting">;
  readonly proposalRepository: Pick<CopilotRepositoryPort, "createProposal">;
  readonly proposalAdapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter>;
  readonly auditService: CopilotAuditPort;
}): ReadonlyArray<CopilotToolDescriptor> => {
  const directiveAdapter = proposalAdapter(deps.proposalAdapters, "directive");
  const settingAdapter = proposalAdapter(deps.proposalAdapters, "agent_setting");
  const routineAdapter = proposalAdapter(deps.proposalAdapters, "routine");
  return [
    {
      name: "propose_directive", shape: "propose", uiLabel: "Drafting a directive", contributingModule: "directives", requiredPermission: "workspace.agents.manage",
      description: "Draft a directive proposal for the operator to review and apply. This does not change configuration.",
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema.optional(), intent: z.string().trim().min(1).max(20_000) }).strict(),
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_directive",
        description: "Draft a directive proposal for operator review. It does not change configuration.",
        inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), directiveId: idSchema.optional(), intent: z.string().trim().min(1).max(20_000) }).strict(),
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, directiveId, intent }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), directiveId: directiveId ?? null };
          const draft = await directiveAdapter.draft(context.workspaceId, targetRef, intent);
          const versionToken = await directiveAdapter.readVersionToken(context.workspaceId, targetRef);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            conversationId: requiredCopilotConversation(context),
            targetType: "directive",
            targetRef,
            payload: draft.payload,
            versionToken,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "directive" as const, targetLabel: draft.targetLabel, summary: draft.summary };
        },
      }),
      describeEntity: (input, context) => {
        const parsed = input as { agentId?: string; agentName?: string };
        return parsed.agentName
          ? describeNamedAgent(parsed, context, deps.agentService)
          : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
      },
    },
    {
      name: "propose_routine", shape: "propose", uiLabel: "Drafting a routine", contributingModule: "routines", requiredPermission: "workspace.agents.manage",
      description: "Draft a new routine proposal for the operator to review and apply. This does not change configuration.",
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), intent: z.string().trim().min(1).max(2_000) }).strict(),
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_routine",
        description: "Draft a new routine proposal for operator review. It does not change configuration.",
        inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), intent: z.string().trim().min(1).max(2_000) }).strict(),
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, intent }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), routineId: null };
          const draft = await routineAdapter.draft(context.workspaceId, targetRef, intent);
          const versionToken = await routineAdapter.readVersionToken(context.workspaceId, targetRef);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            conversationId: requiredCopilotConversation(context),
            targetType: "routine",
            targetRef,
            payload: draft.payload,
            versionToken,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "routine" as const, targetLabel: draft.targetLabel, summary: draft.summary };
        },
      }),
      describeEntity: (input, context) => {
        const parsed = input as { agentId?: string; agentName?: string };
        return parsed.agentName
          ? describeNamedAgent(parsed, context, deps.agentService)
          : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
      },
    },
    {
      name: "propose_agent_setting", shape: "propose", uiLabel: "Drafting a setting change", contributingModule: "agents", requiredPermission: "workspace.agents.manage",
      description: "Draft an agent setting change for the operator to review and apply. This does not change configuration.",
      inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), settingKey: z.string().trim().min(1).max(200), value: z.unknown(), rationale: z.string().trim().min(1).max(1_000).optional() }).strict(),
      outputSchema: proposalOutputSchema,
      createTool: (context) => ({
        name: "propose_agent_setting",
        description: "Draft an agent setting change for operator review. It does not change configuration.",
        inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), settingKey: z.string().trim().min(1).max(200), value: z.unknown(), rationale: z.string().trim().min(1).max(1_000).optional() }).strict(),
        outputSchema: proposalOutputSchema,
        invoke: async ({ agentId, settingKey, value, rationale }) => {
          const targetRef = { agentId: agentId ?? requiredPageAgent(context.pageContext.agentId), settingKey };
          const validated = await settingAdapter.validatePayload(context.workspaceId, targetRef, { value, ...(rationale ? { rationale } : {}) });
          const versionToken = await settingAdapter.readVersionToken(context.workspaceId, validated.targetRef);
          const proposal = await deps.proposalRepository.createProposal({
            workspaceId: context.workspaceId,
            operatorUserId: context.operatorUserId,
            conversationId: requiredCopilotConversation(context),
            targetType: "agent_setting",
            targetRef: validated.targetRef,
            payload: validated.payload,
            versionToken,
          });
          await recordProposalCreated(deps.auditService, context, proposal);
          return { proposalId: proposal.id, targetType: "agent_setting" as const, targetLabel: settingKey, summary: rationale ?? settingKey };
        },
      }),
      describeEntity: (input, context) => {
        const parsed = input as { agentId?: string; agentName?: string };
        return parsed.agentName
          ? describeNamedAgent(parsed, context, deps.agentService)
          : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
      },
    },
  ];
};

const proposalAdapter = <TType extends "directive" | "agent_setting" | "routine">(
  adapters: ReadonlyArray<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter>,
  targetType: TType,
): Extract<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter, { targetType: TType }> => {
  const adapter = adapters.find((candidate) => candidate.targetType === targetType);
  if (!adapter) throw new Error(`No copilot proposal adapter registered for ${targetType}`);
  return adapter as Extract<CopilotDirectiveProposalAdapter | CopilotAgentSettingProposalAdapter | CopilotRoutineProposalAdapter, { targetType: TType }>;
};

const requiredCopilotConversation = (context: { copilotConversationId?: string }): string => {
  const conversationId = context.copilotConversationId;
  if (!conversationId) throw new Error("Copilot proposal drafting requires a persisted conversation");
  return conversationId;
};

const recordProposalCreated = async (auditService: CopilotAuditPort, context: { accountId: string; workspaceId: string }, proposal: CopilotProposal): Promise<void> => {
  await auditService.record({ accountId: context.accountId, workspaceId: context.workspaceId, eventType: "copilot.proposal.created", eventStatus: "success", metadata: { proposalId: proposal.id, targetType: proposal.targetType } });
};

const entity = (type: string, id: string | null | undefined) => id ? { type, id } : null;

type NamedAgentInput = {
  readonly agentId?: string;
  readonly agentName?: string;
};

const describeNamedAgent = async <TInput extends NamedAgentInput>(
  input: TInput,
  context: { workspaceId: string; pageContext: { agentId: string | null } } | undefined,
  agentService: Pick<AgentService, "listExisting"> | undefined,
): Promise<CopilotEntityDescription<TInput> | null> => {
  if (input.agentId) return entity("agent", input.agentId);
  if (!input.agentName) return entity("agent", context?.pageContext.agentId);
  if (!context) return { kind: "not_found" };

  if (!agentService) return { kind: "not_found" };
  const candidates = (await agentService.listExisting(context.workspaceId))
    .filter((agent) => normalizeEntityName(agent.name) === normalizeEntityName(input.agentName!))
    .map((agent) => ({ type: "agent", id: agent.id, label: agent.name }));
  if (candidates.length !== 1) {
    return candidates.length === 0 ? { kind: "not_found" } : { kind: "ambiguous", candidates };
  }
  const candidate = candidates[0]!;
  return {
    kind: "resolved",
    entity: candidate,
    input: { ...input, agentId: candidate.id, agentName: undefined } as TInput,
  };
};

const describeNamedRoutine = async (
  input: { agentId?: string; agentName?: string; routineId?: string; routineTitle?: string },
  context: { workspaceId: string; pageContext: { agentId: string | null } } | undefined,
  deps: Pick<Parameters<typeof createUs1CopilotTools>[0], "agentService" | "routineDefinitionService">,
): Promise<CopilotEntityDescription<typeof input> | null> => {
  const agentDescription = await describeNamedAgent(input, context, deps.agentService);
  if (agentDescription && "kind" in agentDescription && agentDescription.kind !== "resolved") {
    return agentDescription;
  }
  const resolvedInput = agentDescription && "kind" in agentDescription
    ? agentDescription.input
    : input;
  const agentId = resolvedInput.agentId ?? context?.pageContext.agentId ?? undefined;

  if (resolvedInput.routineId) {
    return { type: "routine", id: resolvedInput.routineId, ...(agentId ? { agentId } : {}) };
  }
  if (!resolvedInput.routineTitle) {
    return entity("agent", agentId);
  }
  if (!context) return { kind: "not_found" };

  const agents = agentId
    ? [{ id: agentId }]
    : (await deps.agentService.listExisting(context.workspaceId)).map((agent) => ({ id: agent.id }));
  const routines = (await Promise.all(agents.map(async (agent) =>
    (await deps.routineDefinitionService.list(context.workspaceId, agent.id)).map((routine) => ({
      agentId: agent.id,
      id: routine.id,
      label: routine.name,
    })),
  ))).flat().filter((routine) => normalizeEntityName(routine.label) === normalizeEntityName(resolvedInput.routineTitle!));
  if (routines.length !== 1) {
    return routines.length === 0
      ? { kind: "not_found" }
      : { kind: "ambiguous", candidates: routines.map((routine) => ({ type: "routine", ...routine })) };
  }
  const routine = routines[0]!;
  return {
    kind: "resolved",
    entity: { type: "routine", ...routine },
    input: { ...resolvedInput, agentId: routine.agentId, routineId: routine.id, routineTitle: undefined },
  };
};

const normalizeEntityName = (value: string): string => value.trim().normalize("NFKC").toLowerCase();
const asRecord = (value: object): Record<string, unknown> => value as Record<string, unknown>;
const requiredPageAgent = (agentId: string | null): string => { if (!agentId) throw new Error("No agent context is available"); return agentId; };
const requiredPageConversation = (conversationId: string | null): string => { if (!conversationId) throw new Error("No conversation context is available"); return conversationId; };
const agentIdForEvalCase = (item: Record<string, unknown>): string | null => {
  const agent = item.agent;
  return agent && typeof agent === "object" && "agentId" in agent && typeof agent.agentId === "string" ? agent.agentId : null;
};
const newestEvalResultFirst = (left: Record<string, unknown>, right: Record<string, unknown>): number => latestEvalTime(right) - latestEvalTime(left);
const latestEvalTime = (item: Record<string, unknown>): number => {
  const latestRun = item.latestRun;
  if (!latestRun || typeof latestRun !== "object") return 0;
  const completedAt = "completedAt" in latestRun ? latestRun.completedAt : undefined;
  const startedAt = "startedAt" in latestRun ? latestRun.startedAt : undefined;
  const timestamp = typeof completedAt === "string" ? completedAt : typeof startedAt === "string" ? startedAt : undefined;
  const value = timestamp ? Date.parse(timestamp) : 0;
  return Number.isFinite(value) ? value : 0;
};
