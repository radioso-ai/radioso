import type { Page, Route } from "@playwright/test";
import type { components } from "../../../typescript-sdk/src/generated/types";
import type { SkillAuthoringDescriptor } from "@/lib/api-routine-skill-catalog";

type ApiSchemas = components["schemas"];

export const workspaceId = "workspace-1";
export const workspaceKey = "workspace-key";
export const accountId = "account-1";
export const defaultAgentId = "67acb0c8-caad-4a1b-9fef-70cbca3f7d12";

export const nowIso = "2026-04-26T12:00:00.000Z";

type AuthoredDirectiveFixture = ApiSchemas["AuthoredDirective"];
// What a spec has to state to seed a directive: the rest is filled from the same defaults the
// API applies.
export type AuthoredDirectiveDraftFixture =
  Partial<AuthoredDirectiveFixture> & Pick<AuthoredDirectiveFixture, "id" | "name" | "action">;
type BuiltInDirectiveFixture = ApiSchemas["BuiltInDirective"];
export type ContextVariableFixture = ApiSchemas["ContextVariable"];
export type AgentContextVariableEnablementFixture = ApiSchemas["AgentContextVariableEnablement"];
export type ContextVariableRequestFixture = {
  method: "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  body?: unknown;
};
type ChannelLifecycleFixture = {
  lastUsedAt: string | null;
};
type ChannelsLifecycleFixture = {
  anonymousChat: ChannelLifecycleFixture;
  websiteEmbed: ChannelLifecycleFixture;
};
type DirectiveMutationFixture = {
  method: "POST" | "PATCH" | "DELETE";
  directiveId?: string;
  body?: unknown;
};
export type RoutineFixture = ApiSchemas["RoutineDefinition"];
type RoutineDraftFixture = ApiSchemas["RoutineDefinitionCreateRequest"];
type RoutineDraftAssistFixture = {
  draft: RoutineDraftFixture;
  validation: ApiSchemas["RoutineValidationResult"];
};
export type RoutineMutationFixture = {
  method: "POST" | "PATCH" | "DELETE" | "VALIDATE" | "PUBLISH" | "ASSIST" | "REVISE" | "ARCHIVE" | "RESTORE";
  routineId?: string;
  body?: Partial<RoutineDraftFixture>;
};
type WebhookDestinationFixture = ApiSchemas["WebhookDestination"];
export type McpConnectionFixture = {
  id: string;
  displayName: string;
  serverUrl: string;
  authMethod: string;
  status: string;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
};
export type DiscoveredMcpToolFixture = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};
export type AgentChannelCredentialFixture = {
  id: string;
  audience: "mcp" | "rest";
  label: string;
  prefix: string;
  status: "active" | "expired" | "revoked" | "disabled";
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};
export type CustomerEmailSkillFixture = {
  id: string;
  workspaceId: string;
  agentId: string;
  connectionId: string;
  skillName: string;
  mode: "draft" | "send";
  boundInputs: Record<string, unknown>;
  exposedInputs: Record<string, { description?: string; slotBinding?: string }>;
  enabled: boolean;
  outcomes: string[];
  createdAt: string;
  updatedAt: string;
};
export type CustomerEmailActivityFixture = {
  id: string;
  workspaceId: string;
  agentId: string;
  routineId: string | null;
  conversationId: string | null;
  skillDefinitionId: string;
  connectionId: string;
  skillName: string;
  mode: "draft" | "send";
  outcome: "drafted" | "sent" | "missing_input" | "disabled_connection" | "needs_reauth" | "provider_rejected" | "failed";
  recipientSummary: {
    toCount: number;
    ccCount: number;
    domains: string[];
    redactedRecipients: string[];
  };
  providerMessageId: string | null;
  errorCode: string | null;
  createdAt: string;
};
export type SlackInstallStatusFixture = {
  status: "connected" | "needs_reauth" | "disabled" | "not_configured";
  readiness?: {
    configured: boolean;
    missingEnvVars: string[];
  };
  installationId?: string;
  teamName?: string;
  answeringAgentId?: string;
};
export type SlackBindingFixture = {
  channelId: string | null;
  answeringAgentId: string | null;
  escalationChannelId: string | null;
  gapEscalationEnabled: boolean;
};

export type SlackManifestFixture = {
  manifest: Record<string, unknown>;
  requiredEnvVars: string[];
};
export type SlackSkillFixture = {
  id: string;
  workspaceId: string;
  agentId: string;
  installationId: string;
  skillName: string;
  boundInputs: Record<string, unknown>;
  exposedInputs: Record<string, { slotBinding?: string; required?: boolean }>;
  enabled: boolean;
  outcomes: Array<"enqueued" | "missing_input" | "failed">;
  createdAt: string;
  updatedAt: string;
};
export type AgentSkillFixture = {
  id: string;
  workspaceId: string;
  agentId: string;
  name: string;
  capability: "retrieve" | "mcp_tool" | "email" | "slack_post" | "webhook_call" | "notify";
  storedKind: string;
  target: { kind: string; id: string | null };
  config: Record<string, unknown>;
  invocationMode: "default_answer" | "routine_named" | "agent_selectable";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};
export type SkillCapabilityFixture = {
  id: AgentSkillFixture["capability"];
  storedKind: string;
  targetKind: string;
  requiresTarget: boolean;
  inputSchema: { source: "discovered" } | { source: "static"; schema: Record<string, unknown> };
  settingsFields: Array<{
    key: string;
    label: string;
    type: "boolean" | "number" | "text" | "textarea" | "select" | "string_list" | "source_scope" | "metadata_rules";
    help?: string;
    defaultValue?: boolean | number | string;
    dependsOnKey?: string;
    options?: Array<{ value: string; label: string }>;
    min?: number;
    max?: number;
    group?: string;
    advanced?: boolean;
  }>;
  outcomeVocabulary: string[];
  supportedInvocationModes: AgentSkillFixture["invocationMode"][];
  defaultInvocationMode?: AgentSkillFixture["invocationMode"];
  executorAdapter: string;
  targets: Array<{ id: string; label: string; status?: string }>;
  available: boolean;
  unavailableReason: string | null;
};
export type RoutineSkillCatalogFixture = SkillAuthoringDescriptor[];
export type WebhookDestinationMutationFixture = {
  method: "POST" | "PUT" | "DELETE" | "ROTATE_SECRET";
  destinationId?: string;
  body?: unknown;
};

export const basePlatformSettings = (): ApiSchemas["PlatformSettingsResponse"] => ({
  assistant: {
    assistantName: "Marta",
    greetingInstruction: "",
    assistantDefaultLocale: "en-US",
    proactiveGreetingEnabled: true,
    assistantBootstrapActive: true,
    assistantLogoUrl: null,
    suggestedQuestionsEnabled: true,
    customInstruction: "Keep answers concise.",
  },
  channels: {
    anonymousChatEnabled: false,
    anonymousChatUrl: "http://localhost:3000/chat/public-token",
    anonymousChatLastUsedAt: null,
    websiteEmbedEnabled: false,
    websiteEmbedToken: "embed-token",
    websiteEmbedLastUsedAt: null,
    websiteEmbedScriptUrl: "http://localhost:3000/embed.js",
    websiteEmbedSnippet: "<script src=\"http://localhost:3000/embed.js\"></script>",
    websiteEmbedAllowedOrigins: [],
    websiteEmbedLauncherLabel: "Chat with us",
    websiteEmbedLauncherPosition: "bottom-right",
    websiteEmbedTheme: {
      brand: "#0f172a",
      brandText: "#f8fafc",
      surface: "#ffffff",
      text: "#0f172a",
    },
    websiteEmbedCopy: {},
    websiteEmbedExpertOverrides: {},
  },
});

export type PlatformSettingsFixture = ReturnType<typeof basePlatformSettings>;

export const baseRetrievalDefaults = (): ApiSchemas["RetrievalDefaultsResponse"] => ({
  queryRewriteEnabled: false,
  temporalStructuredLookupEnabled: true,
  temporalBoostUpcomingEnabled: true,
  temporalDeterministicSortEnabled: true,
  semanticRewriteInstructions: "Keep semantic rewrites standalone.",
  lexicalRewriteInstructions: "Prefer exact phrases.",
  suggestedQuestionsEnabled: true,
  suggestedQuestionsCount: 3,
  rerankEnabled: false,
  vectorTopK: 20,
  rerankTopK: 5,
  retrievalStrategy: "fixed",
  customInstruction: "Keep answers concise.",
  metadataFieldSuggestions: [
    { field: "region", inferredType: "string" },
    { field: "publishedAt", inferredType: "date" },
  ],
  metadataRules: [],
});

export type RetrievalDefaultsFixture = ReturnType<typeof baseRetrievalDefaults>;

export const baseIngestionSettings = (): ApiSchemas["IngestionSettings"] => ({
  workspaceId,
  chunkingStrategy: "fixed_window",
  fixedWindowChunkSize: 1000,
  fixedWindowChunkOverlap: 200,
  structuredMinChunkSize: 200,
  structuredMaxChunkSize: 1200,
  embeddingModel: "text-embedding-3-small",
  pendingEmbeddingModel: null,
  documentEnrichmentEnabled: false,
  manualDocumentEnrichmentOverride: "inherit",
  supportedEmbeddingModels: [
    "text-embedding-3-small",
    "text-embedding-3-large",
    "text-embedding-ada-002",
    "gemini-embedding-001",
  ],
  createdAt: nowIso,
  updatedAt: nowIso,
});

export type IngestionSettingsFixture = ReturnType<typeof baseIngestionSettings>;

export const baseDocumentTypeCatalog = (): ApiSchemas["DocumentTypeCatalog"] => ({
  workspaceId,
  revision: "1",
  types: [
    {
      key: "event",
      label: "Event",
      description: "Event announcements — anything scheduled on a date or a date range.",
      enabled: true,
      origin: "built_in",
      payload: "facts",
      disableable: true,
      fields: [
        { key: "dateFrom", label: "Start date", valueType: "date", instruction: "The first day the document's dated subject covers." },
        { key: "dateTo", label: "End date", valueType: "date", instruction: "The last day the document's dated subject covers." },
      ],
    },
    {
      key: "article",
      label: "Article",
      description: "Dated articles — news, posts, and releases carrying a publication date.",
      enabled: true,
      origin: "built_in",
      payload: "facts",
      disableable: true,
      fields: [
        { key: "dateFrom", label: "Start date", valueType: "date", instruction: "The first day the document's dated subject covers." },
        { key: "dateTo", label: "End date", valueType: "date", instruction: "The last day the document's dated subject covers." },
      ],
    },
    {
      key: "profile",
      label: "Profile",
      description: "People or organizations.",
      enabled: true,
      origin: "built_in",
      payload: "none",
      disableable: true,
      fields: [],
    },
    {
      key: "reference",
      label: "Reference",
      description: "Stable reference material.",
      enabled: true,
      origin: "built_in",
      payload: "none",
      disableable: true,
      fields: [],
    },
    {
      key: "generic",
      label: "Generic",
      description: "The reserved fallback for documents that match no other type.",
      enabled: true,
      origin: "built_in",
      payload: "none",
      disableable: false,
      fields: [],
    },
  ],
  retiredFields: [],
  referencedFieldKeys: [],
});

export type DocumentTypeCatalogFixture = ReturnType<typeof baseDocumentTypeCatalog>;

export const baseEmbeddingCoverage = (): ApiSchemas["EmbeddingCoverage"] => ({
  eligibleChunks: 0,
  coveredChunks: 0,
  missingChunks: 0,
  hasEmbeddingProfile: true,
  queuedJobs: 0,
  failedJobs: 0,
});

export type EmbeddingCoverageFixture = ReturnType<typeof baseEmbeddingCoverage>;

export const baseWebhookDestination = (): WebhookDestinationFixture => ({
  id: "33333333-3333-4333-8333-333333333333",
  name: "crm-leads",
  url: "https://hooks.example.com/leads",
  lastDeliveryStatus: null,
  lastDeliveryAt: null,
  createdAt: nowIso,
  updatedAt: nowIso,
});

const buildDefaultAgentSettings = (settings: PlatformSettingsFixture): ApiSchemas["ConversationAgent"] => ({
  id: defaultAgentId,
  workspaceId,
  name: settings.assistant.assistantName,
  internalName: "",
  isDefault: true,
  customInstruction: settings.assistant.customInstruction,
  suggestedQuestionsEnabled: settings.assistant.suggestedQuestionsEnabled,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  contactRequestsEnabled: false,
  webhookExportsEnabled: false,
  contactRequestDelivery: {
    recipientEmails: [],
    webhook: null,
  },
  theme: settings.channels.websiteEmbedTheme,
  branding: {
    hidePoweredBy: false,
    privacyPolicyUrl: null,
  },
  greetingInstruction: settings.assistant.greetingInstruction,
  assistantDefaultLocale: settings.assistant.assistantDefaultLocale,
  proactiveGreetingEnabled: settings.assistant.proactiveGreetingEnabled,
  assistantBootstrapActive: settings.assistant.assistantBootstrapActive,
  logo: null,
  retrievalEnabled: true,
  sourceScope: { mode: "all" },
  chatModelOverride: null,
  skillSettings: {},
  surfaceSettings: {
    authenticatedChat: {
      enabled: true,
    },
    anonymousChat: {
      enabled: settings.channels.anonymousChatEnabled,
      token: "public-token",
    },
    websiteEmbed: {
      enabled: settings.channels.websiteEmbedEnabled,
      token: settings.channels.websiteEmbedToken,
      allowedOrigins: settings.channels.websiteEmbedAllowedOrigins,
      launcherLabel: settings.channels.websiteEmbedLauncherLabel,
      launcherPosition: settings.channels.websiteEmbedLauncherPosition,
      theme: settings.channels.websiteEmbedTheme,
      copy: settings.channels.websiteEmbedCopy,
      expertOverrides: settings.channels.websiteEmbedExpertOverrides,
    },
  },
  createdAt: nowIso,
  updatedAt: nowIso,
});

const validateRoutineFixture = (routine: RoutineDraftFixture | RoutineFixture): ApiSchemas["RoutineValidationResult"] => {
  const diagnostics: ApiSchemas["RoutineValidationResult"]["diagnostics"] = [];
  const stepIds = new Set(routine.steps.map((step) => step.stableStepId));
  const terminalIds = new Set(routine.terminals.map((terminal) => terminal.stableStepId));
  const nodeIds = new Set([...stepIds, ...terminalIds]);
  const slotKeys = new Set(routine.slots.map((slot) => slot.key));
  const referencedSlots = new Set<string>();

  for (const step of routine.steps) {
    for (const match of step.instruction.matchAll(/\{\{\s*slot\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu)) {
      if (match[1]) referencedSlots.add(match[1]);
    }
  }
  for (const key of referencedSlots) {
    if (!slotKeys.has(key)) {
      diagnostics.push({
        code: "referenced_undeclared_slot",
        location: `slot:${key}`,
        message: `referenced-but-undeclared slot: "${key}" is referenced but is not declared.`,
      });
    }
  }
  for (const slot of routine.slots) {
    if (!referencedSlots.has(slot.key)) {
      diagnostics.push({
        code: "declared_unused_slot",
        location: `slot:${slot.key}`,
        message: `declared-but-unused slot: "${slot.key}" is declared but never referenced.`,
      });
    }
  }
  for (const transition of routine.transitions) {
    if (!stepIds.has(transition.fromStep) || !nodeIds.has(transition.toRef)) {
      diagnostics.push({
        code: "dangling_step_reference",
        location: `transition:${transition.fromStep}->${transition.toRef}`,
        message: `dangling step reference: transition "${transition.fromStep}" points at "${transition.toRef}".`,
      });
    }
  }
  if (routine.terminals.length === 0 || !routine.transitions.some((transition) => terminalIds.has(transition.toRef))) {
    diagnostics.push({
      code: "missing_terminal",
      location: `routine:${routine.name}`,
      message: `missing terminal: no terminal is reachable from the first step.`,
    });
  }
  return { ok: diagnostics.length === 0, diagnostics };
};

const buildRoutine = (input: RoutineDraftFixture & Partial<Pick<RoutineFixture, "id" | "lineageId" | "status" | "version">>): RoutineFixture => ({
  ...input,
  id: input.id ?? "55555555-5555-4555-8555-000000000001",
  lineageId: input.lineageId ?? input.id ?? "55555555-5555-4555-7555-000000000001",
  agentId: defaultAgentId,
  status: input.status ?? "draft",
  version: input.version ?? 1,
  createdAt: nowIso,
  updatedAt: nowIso,
});

const buildDefaultChannelsLifecycle = (settings: PlatformSettingsFixture): ChannelsLifecycleFixture => ({
  anonymousChat: {
    lastUsedAt: settings.channels.anonymousChatLastUsedAt,
  },
  websiteEmbed: {
    lastUsedAt: settings.channels.websiteEmbedLastUsedAt,
  },
});

export const seedDashboardStorage = async (page: Page) => {
  await page.addInitScript(({ accountIdValue, workspaceIdValue, workspaceKeyValue }) => {
    window.localStorage.setItem(
      "radioso.authUser",
      JSON.stringify({
        userId: "user-1",
        accountId: accountIdValue,
        email: "operator@example.com",
      }),
    );
    window.localStorage.setItem("radioso.lastAccountId", accountIdValue);
    window.localStorage.setItem("radioso.activeWorkspaceId", workspaceIdValue);
    window.localStorage.setItem("radioso.activeWorkspacePublicRouteKey", workspaceKeyValue);
  }, {
    accountIdValue: accountId,
    workspaceIdValue: workspaceId,
    workspaceKeyValue: workspaceKey,
  });
};

const json = async (route: Route, body: unknown, status = 200) => {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
};

const documentListResponse = {
  documents: [
    {
      id: "doc-1",
      title: "Course Guide",
      status: "processed",
      ragStatus: "processed",
      createdAt: nowIso,
      updatedAt: nowIso,
      metadata: {},
      sourceKind: "inline_text",
      retrievalEnabled: true,
      retrievalExpiresAt: null,
    },
  ],
  total: 1,
  nextCursor: null,
  hasMore: false,
};

const emptySearchHistory = {
  searches: [],
  total: 0,
  nextCursor: null,
  hasMore: false,
};

const emptyDocumentSources = {
  sources: [],
};

const buildDirective = (input: Partial<AuthoredDirectiveFixture> & Pick<AuthoredDirectiveFixture, "id" | "name" | "action">): AuthoredDirectiveFixture => ({
  agentId: defaultAgentId,
  condition: { kind: "always" },
  priority: null,
  requiredCapabilities: [],
  dependsOn: [],
  excludes: [],
  surfaces: [],
  routes: [],
  tags: [],
  description: null,
  metadata: {},
  binding: null,
  lifecycle: null,
  enabled: true,
  createdAt: nowIso,
  updatedAt: nowIso,
  ...input,
});

const baseBuiltInDirectives = (): BuiltInDirectiveFixture[] => [
  {
    name: "concise-readable-formatting",
    condition: { kind: "always" },
    action: "Prefer short paragraphs and answer directly.",
    priority: 60,
    description: "Default readable answer formatting for public assistant replies.",
  },
  {
    name: "represent-organization",
    condition: { kind: "always" },
    action: "Represent the organization as its assistant.",
    priority: 80,
    description: "Speak as the represented organization for grounded retrieval answers.",
  },
  {
    name: "inline-supported-links",
    condition: { kind: "always" },
    action: "Use available source URLs as inline links in grounded answers.",
    priority: 90,
    description: "Use available source URLs as inline links in grounded answers.",
  },
];

export const baseDocumentSources = (): ApiSchemas["DocumentSourceListResponse"] => ({
  sources: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "upload",
      name: "Course guide",
      externalId: null,
      lastSyncStatus: null,
      lastSyncedAt: null,
      documentCount: 1,
      documentEnrichmentOverride: "inherit",
      documentMetadata: {},
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      kind: "website",
      name: "Release notes",
      externalId: "https://example.com/releases",
      lastSyncStatus: "completed",
      lastSyncedAt: nowIso,
      documentCount: 3,
      documentEnrichmentOverride: "inherit",
      documentMetadata: { department: "engineering" },
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ],
});

export const baseSkillCapabilities = (): SkillCapabilityFixture[] => [
  {
    id: "retrieve",
    storedKind: "retrieve",
    targetKind: "source_scope",
    requiresTarget: false,
    inputSchema: { source: "static", schema: { fields: ["query"], required: ["query"] } },
    settingsFields: [
      { key: "sourceScope", label: "Source scope", type: "source_scope", group: "Scope" },
      { key: "instruction", label: "Instruction", type: "textarea", group: "Scope" },
      {
        key: "retrievalStrategy",
        label: "Retrieval strategy",
        type: "select",
        options: [
          { value: "fixed", label: "Fixed" },
          { value: "reasoning", label: "Reasoning" },
          { value: "auto", label: "Auto" },
        ],
        help: "Fixed runs one search pass. Reasoning lets the model plan and run multiple searches. Auto picks per query.",
        defaultValue: "fixed",
        group: "Retrieval tuning",
        advanced: true,
      },
      { key: "vectorTopK", label: "Vector top K", type: "number", help: "How many chunks are fetched from the vector index before filtering and reranking.", defaultValue: 15, min: 1, max: 300, group: "Retrieval tuning", advanced: true },
      { key: "rerankEnabled", label: "Rerank results", type: "boolean", help: "Re-score the fetched chunks with a reranker model to improve ordering.", defaultValue: false, group: "Retrieval tuning", advanced: true },
      { key: "rerankTopK", label: "Rerank top K", type: "number", help: "How many chunks survive reranking and are passed to the answer.", defaultValue: 5, dependsOnKey: "rerankEnabled", min: 1, max: 100, group: "Retrieval tuning", advanced: true },
      { key: "metadataRules", label: "Metadata rules", type: "metadata_rules", group: "Retrieval tuning", advanced: true },
      { key: "temporalStructuredLookupEnabled", label: "Temporal structured lookup", type: "boolean", help: "When someone asks for upcoming events without naming one, also fetch documents by their extracted event dates instead of relying on text similarity alone. Needs metadata extraction enabled on the knowledge base.", defaultValue: true, group: "Temporal retrieval", advanced: true },
      { key: "temporalBoostUpcomingEnabled", label: "Upcoming event boost", type: "boolean", help: "Rank documents about ongoing or upcoming events above past ones when the question is about event dates.", defaultValue: true, group: "Temporal retrieval", advanced: true },
      { key: "temporalDeterministicSortEnabled", label: "Deterministic temporal sort", type: "boolean", help: "Present event evidence in date order (soonest first) for event-date questions, instead of relying on the model to order them.", defaultValue: true, group: "Temporal retrieval", advanced: true },
      { key: "queryRewriteEnabled", label: "Query rewrite", type: "boolean", help: "Rewrite the user message into search queries before retrieval.", defaultValue: true, group: "Query rewrite", advanced: true },
      { key: "semanticRewriteInstructions", label: "Semantic rewrite instructions", type: "textarea", help: "Instructions used to rewrite the user message into the semantic (vector) search query. Replaces the default; leave empty to keep the default shown.", defaultValue: "Rewrite for semantic retrieval with the same meaning.", dependsOnKey: "queryRewriteEnabled", group: "Query rewrite", advanced: true },
      { key: "lexicalRewriteInstructions", label: "Lexical rewrite instructions", type: "textarea", help: "Instructions used to rewrite the user message into the lexical (keyword) search query. Replaces the default; leave empty to keep the default shown.", defaultValue: "Produce a concise keyword-style query.", dependsOnKey: "queryRewriteEnabled", group: "Query rewrite", advanced: true },
      { key: "suggestedQuestionsEnabled", label: "Suggested questions", type: "boolean", help: "Offer follow-up question suggestions after each answer.", defaultValue: true, group: "Suggested questions" },
      { key: "suggestedQuestionsCount", label: "Suggested questions count", type: "number", help: "How many follow-up questions to suggest.", defaultValue: 3, dependsOnKey: "suggestedQuestionsEnabled", min: 1, max: 4, group: "Suggested questions" },
    ],
    outcomeVocabulary: ["found", "empty"],
    supportedInvocationModes: ["default_answer", "routine_named", "agent_selectable"],
    defaultInvocationMode: "default_answer",
    executorAdapter: "retrieval.answer",
    targets: [
      { id: "11111111-1111-4111-8111-111111111111", label: "Course guide", status: "ready" },
      { id: "22222222-2222-4222-8222-222222222222", label: "Release notes", status: "ready" },
    ],
    available: true,
    unavailableReason: null,
  },
  {
    id: "mcp_tool",
    storedKind: "external_mcp",
    targetKind: "mcp_connection",
    requiresTarget: true,
    inputSchema: { source: "discovered" },
    settingsFields: [],
    outcomeVocabulary: ["completed", "failed"],
    supportedInvocationModes: ["routine_named", "agent_selectable"],
    defaultInvocationMode: "routine_named",
    executorAdapter: "external_mcp",
    targets: [],
    available: false,
    unavailableReason: "no_connection",
  },
  {
    id: "email",
    storedKind: "customer_email",
    targetKind: "customer_email_connection",
    requiresTarget: true,
    inputSchema: { source: "static", schema: { fields: ["to", "cc", "subject", "bodyText", "bodyHtml", "replyTo"], required: ["to", "subject", "bodyText"] } },
    settingsFields: [
      {
        key: "mode",
        label: "Mode",
        type: "select",
        options: [
          { value: "draft", label: "Draft" },
          { value: "send", label: "Send" },
        ],
      },
    ],
    outcomeVocabulary: ["drafted", "sent", "missing_input", "disabled_connection", "needs_reauth", "provider_rejected", "failed"],
    supportedInvocationModes: ["routine_named", "agent_selectable"],
    defaultInvocationMode: "routine_named",
    executorAdapter: "customer_email",
    targets: [{ id: "99999999-9999-4999-8999-000000000001", label: "Support outbound", status: "authorized" }],
    available: true,
    unavailableReason: null,
  },
  {
    id: "slack_post",
    storedKind: "slack",
    targetKind: "slack_installation",
    requiresTarget: true,
    inputSchema: { source: "static", schema: { fields: ["channelId", "text", "threadTs"], required: ["channelId", "text"] } },
    settingsFields: [],
    outcomeVocabulary: ["enqueued", "missing_input", "failed"],
    supportedInvocationModes: ["routine_named", "agent_selectable"],
    defaultInvocationMode: "routine_named",
    executorAdapter: "slack",
    targets: [],
    available: false,
    unavailableReason: "no_connection",
  },
  {
    id: "webhook_call",
    storedKind: "webhook",
    targetKind: "webhook_destination",
    requiresTarget: true,
    inputSchema: { source: "static", schema: { fields: ["payload"], required: ["payload"] } },
    settingsFields: [],
    outcomeVocabulary: ["delivered", "failed"],
    supportedInvocationModes: ["routine_named", "agent_selectable"],
    defaultInvocationMode: "routine_named",
    executorAdapter: "webhook",
    targets: [{ id: "33333333-3333-4333-8333-333333333333", label: "crm-leads", status: "available" }],
    available: true,
    unavailableReason: null,
  },
  {
    id: "notify",
    storedKind: "notify",
    targetKind: "notify_delivery",
    requiresTarget: false,
    inputSchema: { source: "static", schema: { fields: ["message", "email"], required: ["message"] } },
    settingsFields: [
      { key: "delivery.recipientEmails", label: "Recipient emails", type: "string_list", group: "Delivery" },
      { key: "delivery.webhook.url", label: "Webhook URL", type: "text", group: "Delivery" },
    ],
    outcomeVocabulary: ["delivered", "failed"],
    supportedInvocationModes: ["routine_named", "agent_selectable"],
    defaultInvocationMode: "routine_named",
    executorAdapter: "notify",
    targets: [],
    available: true,
    unavailableReason: null,
  },
];

const emptyCrawlJobs = {
  jobs: [],
  total: 0,
  nextCursor: null,
  hasMore: false,
};

const buildWorkspaceSummary = (input: {
  documentList: unknown;
  historyList: unknown;
}) => {
  const documentList = input.documentList as {
    documents?: Array<{ ragStatus?: string; status?: string; metadata?: Record<string, unknown> }>;
    total?: number;
  };
  const historyList = input.historyList as { total?: number };
  const documents = Array.isArray(documentList.documents) ? documentList.documents : [];
  const documentCount = documentList.total ?? documents.length;
  const readyDocumentCount = documents.filter((document) => document.ragStatus === "processed" || document.status === "ready").length;
  const pendingDocumentCount = Math.max(0, documentCount - readyDocumentCount);
  const sampleDocumentSlugs = documents
    .filter((document) => document.metadata?.sampleDocument === true)
    .map((document) => document.metadata?.sampleSlug)
    .filter((value): value is string => typeof value === "string");
  const conversationCount = historyList.total ?? 0;

  return {
    documentCount,
    readyDocumentCount,
    pendingDocumentCount,
    sampleDocumentCount: sampleDocumentSlugs.length,
    sampleDocumentSlugs,
    conversationCount,
    hasDocuments: documentCount > 0,
    hasPendingDocuments: pendingDocumentCount > 0,
    hasReadyDocuments: readyDocumentCount > 0,
    hasCompletedChat: conversationCount > 0,
    sampleDocumentsImported: sampleDocumentSlugs.length > 0,
    websiteCrawlerEnabled: true,
  };
};

const qualityMetric = (count: number, denominator: number) => ({
  count,
  denominator,
  rate: denominator === 0 ? null : count / denominator,
});

/**
 * Quality health rollup. Every window sits well above the dashboard's
 * MIN_RATE_SAMPLE floor so rates and deltas render by default; a spec that wants
 * the "too few to rate" path passes its own thin payload via `qualityStats`.
 */
export const baseQualityStats = () => ({
  range: "30d" as const,
  filters: {},
  current: {
    from: "2026-03-27T00:00:00.000Z",
    to: "2026-04-26T00:00:00.000Z",
    turnCount: 600,
    grounded: qualityMetric(420, 480),
    negativeFeedback: qualityMetric(24, 120),
    skillFailures: qualityMetric(12, 600),
  },
  previous: {
    from: "2026-02-25T00:00:00.000Z",
    to: "2026-03-27T00:00:00.000Z",
    turnCount: 500,
    grounded: qualityMetric(391, 460),
    negativeFeedback: qualityMetric(39, 130),
    skillFailures: qualityMetric(20, 500),
  },
  buckets: Array.from({ length: 30 }, (_, index) => ({
    date: `2026-04-${String(index + 1).padStart(2, "0")}`,
    turnCount: 12 + index,
    grounded: qualityMetric(10 + index, 14 + index),
    negativeFeedback: qualityMetric(1, 6),
    skillFailures: qualityMetric(index % 3, 12 + index),
  })),
  backlog: {
    negative_feedback: 7,
    grounding_gaps: 3,
    skill_failures: 2,
  },
  resolutionBreakdown: [],
});

export const installDashboardApiMocks = async (
  page: Page,
  options: {
    platformSettings?: PlatformSettingsFixture;
    retrievalDefaults?: RetrievalDefaultsFixture;
    documentList?: unknown;
    documentDetails?: Record<string, Record<string, unknown>>;
    settingsUpdates?: unknown[];
    workspaceSummary?: unknown;
    historyList?: unknown;
    historyItems?: unknown;
    searchHistory?: unknown;
    documentSources?: unknown;
    conversationDetail?: unknown;
    conversationDetails?: Record<string, unknown>;
    forkConversationResponse?: { conversationId: string };
    pendingDecisions?: ApiSchemas["PendingApprovalDecision"][];
    conversationTailResponses?: ApiSchemas["ChatConversationTail"][];
    takeOverConversationResponse?: ApiSchemas["ConversationOwnershipResponse"];
    handBackConversationResponse?: ApiSchemas["ConversationOwnershipResponse"];
    humanReplyResponse?: ApiSchemas["HumanReplyMessageResponse"];
    resolveDecisionResponse?: unknown;
    agentUpdates?: unknown[];
    directiveUpdates?: DirectiveMutationFixture[];
    directives?: AuthoredDirectiveDraftFixture[];
    builtIns?: BuiltInDirectiveFixture[];
    contextVariables?: ContextVariableFixture[];
    contextVariableEnablements?: AgentContextVariableEnablementFixture[];
    contextVariableRequests?: ContextVariableRequestFixture[];
    routineUpdates?: RoutineMutationFixture[];
    routines?: RoutineFixture[];
    routineDraftAssist?: RoutineDraftAssistFixture;
    webhookDestinations?: WebhookDestinationFixture[];
    webhookDestinationUpdates?: WebhookDestinationMutationFixture[];
    requestLog?: string[];
    providerEncryptionConfigured?: boolean;
    providerCredentialUpdates?: Array<{ method: "PUT" | "DELETE"; provider: string; body?: unknown }>;
    llmModelUpdates?: Array<unknown>;
    ingestionSettings?: IngestionSettingsFixture;
    ingestionSettingsUpdates?: unknown[];
    ingestionSettingsUpdateError?: string;
    documentTypeCatalog?: DocumentTypeCatalogFixture;
    documentTypeCatalogUpdates?: unknown[];
    /** Rejects the first PUT with 409 and the current revision, as a concurrent save does. */
    documentTypeCatalogStaleRevision?: boolean;
    embeddingCoverage?: EmbeddingCoverageFixture;
    usageTrends?: unknown;
    messageUsage?: unknown;
    messageUsageNextPage?: unknown;
    messageUsageLoadMoreDelayMs?: number;
    internalUsage?: unknown;
    qualityStats?: unknown;
    mcpConnections?: McpConnectionFixture[];
    mcpDiscoveredTools?: DiscoveredMcpToolFixture[];
    mcpConnectionRequests?: string[];
    agentChannelCredentials?: AgentChannelCredentialFixture[];
    agentChannelCredentialRequests?: Array<{ method: "GET" | "POST"; path: string; body?: unknown }>;
    mcpHealth?: { enabled: boolean; standalone: boolean; path: string };
    emailSkills?: CustomerEmailSkillFixture[];
    emailActivity?: CustomerEmailActivityFixture[];
    slackStatus?: SlackInstallStatusFixture;
    slackBinding?: SlackBindingFixture;
    slackBindings?: SlackBindingFixture[];
    slackManifest?: SlackManifestFixture;
    slackSkills?: SlackSkillFixture[];
    slackRequests?: Array<{ method: string; path: string; body?: unknown }>;
    skillCapabilities?: SkillCapabilityFixture[];
    agentSkills?: AgentSkillFixture[];
    agentSkillRequests?: Array<{ method: string; path: string; body?: unknown }>;
    routineSkillCatalog?: RoutineSkillCatalogFixture;
  } = {},
) => {
  let platformSettings = options.platformSettings ?? basePlatformSettings();
  const retrievalDefaults = options.retrievalDefaults ?? baseRetrievalDefaults();
  let ingestionSettings = options.ingestionSettings ?? baseIngestionSettings();
  let documentTypeCatalog = options.documentTypeCatalog ?? baseDocumentTypeCatalog();
  const documentTypeCatalogUpdates = options.documentTypeCatalogUpdates;
  let documentTypeCatalogStaleRevisionPending = options.documentTypeCatalogStaleRevision ?? false;
  let agentSettings = buildDefaultAgentSettings(platformSettings);
  let channelsLifecycle = buildDefaultChannelsLifecycle(platformSettings);
  const providerEncryptionConfigured = options.providerEncryptionConfigured ?? true;
  const providerCredentials: Record<string, { updatedAt: string } | null> = {
    openai: null,
    "openai-compatible": null,
    gemini: null,
    claude: null,
  };
  const providerCredentialUpdates = options.providerCredentialUpdates;
  const knownModelsByProvider = {
    openai: ["gpt-5.2", "gpt-5-mini"],
    "openai-compatible": [],
    gemini: [
      "gemini-3.5-flash",
      "gemini-3.1-flash-lite",
      "gemini-3-flash-preview",
      "gemini-flash-latest",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-2.5-flash-lite",
    ],
    claude: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-sonnet-4-5"],
  };
  let llmModels: {
    chat: { provider: string; model: string } | null;
    rewrite: { provider: string; model: string } | null;
    rerank: { provider: string; model: string } | null;
  } = { chat: null, rewrite: null, rerank: null };
  const llmModelUpdates = options.llmModelUpdates;
  const documents = options.documentList ?? documentListResponse;
  const settingsUpdates = options.settingsUpdates;
  const ingestionSettingsUpdates = options.ingestionSettingsUpdates;
  const agentUpdates = options.agentUpdates;
  let directives: AuthoredDirectiveFixture[] = (options.directives ?? []).map(buildDirective);
  const builtIns = options.builtIns ?? baseBuiltInDirectives();
  let nextDirectiveIndex = 1;
  const directiveUpdates = options.directiveUpdates;
  let contextVariables = options.contextVariables ?? [];
  let contextVariableEnablements = options.contextVariableEnablements ?? [];
  let nextContextVariableIndex = contextVariables.length + 1;
  let nextContextVariableEnablementIndex = contextVariableEnablements.length + 1;
  const contextVariableRequests = options.contextVariableRequests;
  let routines = options.routines ?? [];
  let nextRoutineIndex = 1;
  const routineUpdates = options.routineUpdates;
  const emailSkills = options.emailSkills ?? [];
  const emailActivity = options.emailActivity ?? [];
  const slackReady = { configured: true, missingEnvVars: [] };
  let slackStatus = { readiness: slackReady, ...(options.slackStatus ?? { status: "not_configured" as const }) };
  let slackBinding = options.slackBinding ?? {
    channelId: null,
    answeringAgentId: null,
    escalationChannelId: null,
    gapEscalationEnabled: false,
  };
  let slackBindings = options.slackBindings ?? [slackBinding];
  const slackManifest = options.slackManifest ?? {
    manifest: {
      display_information: { name: "Radioso" },
      oauth_config: {
        redirect_urls: ["https://self-host.example.com/api/v1/oauth/callback/slack"],
        scopes: {
          bot: ["app_mentions:read", "chat:write", "im:history", "im:read", "im:write"],
        },
      },
      settings: {
        event_subscriptions: {
          request_url: "https://self-host.example.com/api/connectors/slack/events",
          bot_events: ["app_mention", "message.im"],
        },
      },
    },
    requiredEnvVars: ["SLACK_OAUTH_CLIENT_ID", "SLACK_OAUTH_CLIENT_SECRET", "SLACK_SIGNING_SECRET"],
  };
  let slackSkills = options.slackSkills ?? [];
  let nextSlackSkillIndex = slackSkills.length + 1;
  const skillCapabilities = options.skillCapabilities ?? baseSkillCapabilities();
  let agentSkills = options.agentSkills ?? [];
  let nextAgentSkillIndex = agentSkills.length + 1;
  const routineSkillCatalog = options.routineSkillCatalog ?? [];
  let webhookDestinations = options.webhookDestinations ?? [];
  let nextWebhookDestinationIndex = webhookDestinations.length + 1;
  const mcpConnections = options.mcpConnections ?? [];
  const mcpDiscoveredTools = options.mcpDiscoveredTools ?? [];
  const mcpConnectionRequests = options.mcpConnectionRequests;
  let nextMcpConnectionIndex = mcpConnections.length + 1;
  let agentChannelCredentials = options.agentChannelCredentials ?? [];
  const agentChannelCredentialRequests = options.agentChannelCredentialRequests;
  let nextAgentChannelCredentialIndex = agentChannelCredentials.length + 1;
  const webhookDestinationUpdates = options.webhookDestinationUpdates;
  const coherenceFor = (directive: AuthoredDirectiveFixture): ApiSchemas["DirectiveCoherenceVerdict"] => {
    // Mirrors the backend: a disabled directive is not checked at all, so disabling one
    // always comes back coherent regardless of what would otherwise conflict.
    if (!directive.enabled) {
      return {
        coherent: true,
        conflicts: [],
        rationale: "Skipped: this directive is disabled and was not checked.",
      };
    }
    const hasConflict =
      (directive.name.toLowerCase().includes("conflict") || directive.action.toLowerCase().includes("verbose")) &&
      directive.excludes.length === 0;
    if (!hasConflict) {
      return {
        coherent: true,
        conflicts: [],
        rationale: "No conflicts were detected.",
      };
    }

    const authoredConflict = directives.find((item) => item.id !== directive.id);
    return {
      coherent: false,
      conflicts: authoredConflict
        ? [{
            directiveId: authoredConflict.id,
            directiveName: authoredConflict.name,
            reason: "Both directives steer answer behavior in opposite directions.",
          }]
        : [{
            directiveName: "concise-readable-formatting",
            reason: "Both directives steer answer length in opposite directions.",
          }],
      rationale: "The saved directive may conflict with a formatting rule.",
    };
  };
  const historyList = options.historyList ?? {
    conversations: [],
    total: 0,
    nextCursor: null,
    hasMore: false,
  };
  const searchHistory = options.searchHistory ?? emptySearchHistory;
  let conversationDetail = options.conversationDetail;
  const conversationDetails = new Map<string, unknown>(Object.entries(options.conversationDetails ?? {}));
  if (
    conversationDetail &&
    typeof conversationDetail === "object" &&
    "conversationId" in conversationDetail &&
    typeof conversationDetail.conversationId === "string"
  ) {
    conversationDetails.set(conversationDetail.conversationId, conversationDetail);
  }
  let pendingDecisions = options.pendingDecisions ?? [];
  const conversationTailResponses = [...(options.conversationTailResponses ?? [])];
  let humanReplyCreated = false;
  const documentSources = options.documentSources ?? emptyDocumentSources;
  const historyItems = options.historyItems ?? {
    items: Array.isArray((historyList as { conversations?: unknown[] }).conversations)
      ? (historyList as { conversations: Array<{ id: string; updatedAt: string }> }).conversations.map((conversation) => ({
          kind: "chat",
          id: conversation.id,
          sortAt: conversation.updatedAt,
          conversation,
        }))
      : [],
    total: (historyList as { total?: number }).total ?? 0,
    nextCursor: null,
    hasMore: (historyList as { hasMore?: boolean }).hasMore ?? false,
  };
  const workspaceSummary = options.workspaceSummary ?? buildWorkspaceSummary({ documentList: documents, historyList });
  const usageTrends = options.usageTrends ?? {
    granularity: "day",
    from: "2026-05-28",
    to: "2026-06-26",
    filters: { workspaceId: null, agentId: null },
    buckets: [
      {
        periodStart: "2026-06-01T00:00:00.000Z",
        periodEnd: "2026-06-02T00:00:00.000Z",
        conversationsCreated: 1,
        messages: { total: 2, user: 1, assistant: 1 },
        tokens: { input: 120, output: 80, total: 200 },
      },
      {
        periodStart: "2026-06-02T00:00:00.000Z",
        periodEnd: "2026-06-03T00:00:00.000Z",
        conversationsCreated: 2,
        messages: { total: 4, user: 2, assistant: 2 },
        tokens: { input: 260, output: 140, total: 400 },
      },
    ],
  };
  const messageUsage = options.messageUsage ?? {
    from: "2026-05-28",
    to: "2026-06-26",
    filters: { workspaceId: null },
    items: [
      {
        messageId: "11111111-1111-4111-8111-111111111111",
        conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspaceId,
        agentId: defaultAgentId,
        content: "A visitor message must never be rendered in Usage.",
        lastOccurredAt: nowIso,
        providers: ["openai"],
        models: ["gpt-5.2", "text-embedding-3-small"],
        operations: [{ surface: "assistant", name: "respond", label: "Assistant response" }],
        attempts: { total: 2, succeeded: 2, failed: 0 },
        quality: { actual: 2, estimated: 0 },
        modelTokens: {
          input: 120,
          completion: 80,
          reasoning: { tokens: null, coverage: "unavailable" },
          visibleOutput: null,
          total: 200,
        },
        embeddingTokens: { input: 40, total: 40, vectors: 1, attempts: 1 },
        unknownHistorical: { total: 0, attempts: 0 },
      },
    ],
    nextCursor: "next-message-page",
  };
  const internalUsage = options.internalUsage ?? {
    from: "2026-05-28",
    to: "2026-06-26",
    filters: { workspaceId: null },
    items: [
      {
        eventId: "22222222-2222-4222-8222-222222222222",
        workspaceId,
        agentId: defaultAgentId,
        occurredAt: nowIso,
        kind: "embedding",
        operation: { surface: "documents", name: "document_enrichment", label: "Metadata generation" },
        provider: "openai",
        model: "text-embedding-3-small",
        status: "succeeded",
        usageQuality: "actual",
        tokens: { input: 80, completion: null, reasoning: null, visibleOutput: null, total: 80 },
        vectorCount: 3,
      },
      {
        eventId: "33333333-3333-4333-8333-333333333333",
        workspaceId,
        agentId: defaultAgentId,
        occurredAt: "2026-04-26T11:00:00.000Z",
        kind: "model",
        operation: { surface: "agent_wizard", name: "analyze_website", label: "Agent setup" },
        provider: "openai",
        model: "gpt-5-mini",
        status: "succeeded",
        usageQuality: "actual",
        tokens: { input: 140, completion: 90, reasoning: 30, visibleOutput: 60, total: 230 },
        vectorCount: null,
      },
    ],
    nextCursor: null,
  };
  const qualityStats = options.qualityStats ?? baseQualityStats();

  await page.route("**/backend/health", async (route) => {
    await json(route, {
      status: "ok",
      mcp: options.mcpHealth ?? { enabled: true, standalone: false, path: "/mcp" },
    });
  });

  await page.route("**/backend/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/backend\/api\/v1/, "");
    options.requestLog?.push(`${request.method()} ${path}${url.search}`);

    if (request.method() === "GET" && path === `/workspace/resolve/${workspaceKey}`) {
      await json(route, {
        workspaceKey,
        workspaceId,
        workspaceName: "Default",
        accountId,
        organizationName: "Radioso Test",
        realtimeEnabled: false,
      });
      return;
    }

    if (request.method() === "GET" && path === "/workspace") {
      await json(route, {
        workspaces: [
          {
            id: workspaceId,
            name: "Default",
            publicRouteKey: workspaceKey,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
      });
      return;
    }

    if (request.method() === "GET" && path === "/workspace/summary") {
      await json(route, workspaceSummary);
      return;
    }

    if (request.method() === "GET" && path === "/account/accounts") {
      await json(route, {
        accounts: [
          {
            accountId,
            organizationName: "Radioso Test",
            role: "admin",
            status: "active",
          },
        ],
      });
      return;
    }

    if (request.method() === "GET" && path === "/account/usage-trends") {
      await json(route, usageTrends);
      return;
    }

    if (request.method() === "GET" && path === "/account/usage/messages") {
      const isNextPage = Boolean(url.searchParams.get("cursor"));
      if (isNextPage && options.messageUsageLoadMoreDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.messageUsageLoadMoreDelayMs));
      }
      const nextPage = isNextPage
        ? options.messageUsageNextPage ?? { ...(messageUsage as Record<string, unknown>), items: [], nextCursor: null }
        : messageUsage;
      await json(route, nextPage);
      return;
    }

    if (request.method() === "GET" && path === "/account/usage/internal-operations") {
      await json(route, internalUsage);
      return;
    }

    if (request.method() === "GET" && path === "/document/") {
      await json(route, documents);
      return;
    }

    if (request.method() === "GET" && path === "/document/sources") {
      await json(route, documentSources);
      return;
    }

    if (request.method() === "GET" && path === "/document/crawl/jobs") {
      await json(route, emptyCrawlJobs);
      return;
    }

    if (request.method() === "GET" && path.startsWith("/document/")) {
      const documentId = path.replace("/document/", "");
      const documentListItems = (documents as { documents?: Array<Record<string, unknown>> }).documents ?? [];
      const summary = options.documentDetails?.[documentId] ?? documentListItems.find((document) => document.id === documentId);
      if (summary) {
        await json(route, {
          ...summary,
          content: (summary as { content?: string }).content ?? "Document content",
        });
        return;
      }
    }

    if (request.method() === "GET" && path === "/document/search/history") {
      await json(route, searchHistory);
      return;
    }

    if (request.method() === "GET" && path === "/history") {
      // The All lens's search/outcome/agent/site filters are server-side (issue #1126):
      // simulate just enough of that filtering here so an e2e test that types into the
      // toolbar search box exercises a real request round trip, not client-side narrowing.
      const url = new URL(request.url());
      const q = url.searchParams.get("q");
      const agentId = url.searchParams.get("agentId");
      const sourceOrigin = url.searchParams.get("sourceOrigin");
      const hasFilter = Boolean(q || agentId || sourceOrigin || url.searchParams.get("outcome"));
      const allItems = (historyItems as { items?: Array<Record<string, unknown>> }).items ?? [];
      const filteredItems = !hasFilter ? allItems : allItems.filter((item) => {
        if (item.kind !== "chat") {
          return false;
        }
        const conversation = item.conversation as Record<string, unknown>;
        if (agentId && conversation.agentId !== agentId) {
          return false;
        }
        if (sourceOrigin && conversation.sourceOrigin !== sourceOrigin) {
          return false;
        }
        if (q) {
          const haystack = `${conversation.title ?? ""} ${conversation.preview ?? ""}`.toLowerCase();
          if (!haystack.includes(q.toLowerCase())) {
            return false;
          }
        }
        return true;
      });
      await json(route, hasFilter
        ? { ...historyItems, items: filteredItems, total: filteredItems.length, hasMore: false }
        : historyItems);
      return;
    }

    if (request.method() === "GET" && path === "/history/chat") {
      await json(route, historyList);
      return;
    }

    if (request.method() === "GET" && path === "/agents") {
      await json(route, { agents: [agentSettings] });
      return;
    }

    if (request.method() === "GET" && path === "/history/search") {
      await json(route, searchHistory);
      return;
    }

    if (request.method() === "GET" && path.startsWith("/history/chat/") && path.endsWith("/tail")) {
      const conversationId = path.replace("/history/chat/", "").replace("/tail", "");
      const activeConversationDetail = conversationDetails.get(conversationId) ?? conversationDetail;
      const tailResponse =
        !humanReplyCreated && conversationTailResponses.length > 1
          ? conversationTailResponses[0]
          : conversationTailResponses.shift();
      await json(route, tailResponse ?? {
        messages: [],
        cursor: null,
        ownership: (activeConversationDetail as { ownership?: unknown } | undefined)?.ownership,
      });
      return;
    }

    if (request.method() === "GET" && path.startsWith("/history/chat/")) {
      const conversationId = path.replace("/history/chat/", "");
      const activeConversationDetail = conversationDetails.get(conversationId) ?? conversationDetail;
      if (activeConversationDetail) {
        await json(route, activeConversationDetail);
        return;
      }
    }

    if (request.method() === "GET" && path.startsWith("/history/chat/") && conversationDetail) {
      await json(route, conversationDetail);
      return;
    }

    if (request.method() === "POST" && path.startsWith("/conversations/") && path.endsWith("/fork")) {
      await json(route, options.forkConversationResponse ?? {
        conversationId: "11111111-1111-4111-8111-111111111111",
      }, 201);
      return;
    }

    if (request.method() === "GET" && path === "/decisions") {
      await json(route, { decisions: pendingDecisions });
      return;
    }

    // Quality health rollup. Echoes the requested range so a spec can assert the
    // range control actually refetches with the new window.
    if (request.method() === "GET" && path === "/quality/stats") {
      const requestedRange = url.searchParams.get("range") === "7d" ? "7d" : "30d";
      await json(route, { ...(qualityStats as Record<string, unknown>), range: requestedRange });
      return;
    }

    if (request.method() === "POST" && path.startsWith("/conversations/") && path.endsWith("/takeover")) {
      const response = options.takeOverConversationResponse ?? {
        ownership: {
          conversationId: path.replace("/conversations/", "").replace("/takeover", ""),
          workspaceId,
          state: "human_owned",
          ownerAccountId: accountId,
          ownerDisplayName: "Test Operator",
          reason: null,
          version: 2,
          takenOverAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      };
      if (conversationDetail && typeof conversationDetail === "object") {
        conversationDetail = {
          ...conversationDetail,
          ownership: response.ownership,
        };
      }
      const conversationId = path.replace("/conversations/", "").replace("/takeover", "");
      const activeConversationDetail = conversationDetails.get(conversationId);
      if (activeConversationDetail && typeof activeConversationDetail === "object") {
        conversationDetails.set(conversationId, {
          ...activeConversationDetail,
          ownership: response.ownership,
        });
      }
      if (conversationTailResponses[0] && conversationTailResponses[0].messages.length === 0) {
        conversationTailResponses[0] = {
          ...conversationTailResponses[0],
          ownership: response.ownership,
        };
      }
      await json(route, response);
      return;
    }

    if (request.method() === "POST" && path.startsWith("/conversations/") && path.endsWith("/handback")) {
      const conversationId = path.replace("/conversations/", "").replace("/handback", "");
      const response = options.handBackConversationResponse ?? {
        ownership: {
          conversationId,
          workspaceId,
          state: "ai_owned",
          ownerAccountId: null,
          ownerDisplayName: null,
          reason: null,
          version: 3,
          takenOverAt: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      };
      if (conversationDetail && typeof conversationDetail === "object") {
        conversationDetail = {
          ...conversationDetail,
          ownership: response.ownership,
        };
      }
      const activeConversationDetail = conversationDetails.get(conversationId);
      if (activeConversationDetail && typeof activeConversationDetail === "object") {
        conversationDetails.set(conversationId, {
          ...activeConversationDetail,
          ownership: response.ownership,
        });
      }
      await json(route, response);
      return;
    }

    if (request.method() === "POST" && path.startsWith("/conversations/") && path.endsWith("/reply")) {
      humanReplyCreated = true;
      if (conversationTailResponses.length > 1 && conversationTailResponses[0]?.messages.length === 0) {
        conversationTailResponses.shift();
      }
      await json(route, options.humanReplyResponse ?? {
        message: {
          id: "human-reply-1",
          conversationId: path.replace("/conversations/", "").replace("/reply", ""),
          workspaceId,
          role: "assistant",
          source: "human_agent",
          content: "Human reply",
          createdAt: nowIso,
        },
      }, 201);
      return;
    }

    if (request.method() === "POST" && path.startsWith("/agents/") && path.includes("/decisions/") && path.endsWith("/resolve")) {
      pendingDecisions = pendingDecisions.filter((decision) => !path.includes(`/decisions/${decision.handle}/`));
      await json(route, options.resolveDecisionResponse ?? {
        status: "resolved",
        optionId: "approve",
        conversationId: null,
        resumed: true,
      });
      return;
    }

    if (request.method() === "GET" && path === `/agents/${defaultAgentId}/channels/lifecycle`) {
      await json(route, channelsLifecycle);
      return;
    }

    if (path === `/workspaces/${workspaceId}/slack/install/status` && request.method() === "GET") {
      await json(route, slackStatus);
      return;
    }

    if (path === `/workspaces/${workspaceId}/slack/install/start` && request.method() === "POST") {
      options.slackRequests?.push({ method: request.method(), path });
      slackStatus = {
        status: "connected",
        readiness: slackReady,
        installationId: "99999999-9999-4999-8999-000000000003",
        teamName: "Radioso Test",
        answeringAgentId: defaultAgentId,
      };
      slackBinding = {
        channelId: null,
        answeringAgentId: defaultAgentId,
        escalationChannelId: null,
        gapEscalationEnabled: false,
      };
      slackBindings = [slackBinding];
      await json(route, {
        authorizationUrl: "/oauth/connections/callback?status=authorized&provider=slack",
        connectionId: "99999999-9999-4999-8999-000000000002",
        status: "pending",
      });
      return;
    }

    if (path === `/workspaces/${workspaceId}/slack/bindings` && request.method() === "GET") {
      await json(route, { bindings: slackBindings });
      return;
    }

    if (path === `/workspaces/${workspaceId}/slack/manifest` && request.method() === "GET") {
      await json(route, slackManifest);
      return;
    }

    if (path === `/workspaces/${workspaceId}/slack/binding`) {
      if (request.method() === "GET") {
        await json(route, slackBinding);
        return;
      }

      if (request.method() === "PUT") {
        const body = request.postDataJSON() as SlackBindingFixture;
        options.slackRequests?.push({ method: request.method(), path, body });
        const channelId = body.channelId ?? null;
        const previousBinding = channelId === null
          ? slackBinding
          : slackBindings.find((binding) => binding.channelId === channelId);
        const nextBinding = {
          channelId,
          answeringAgentId: body.answeringAgentId,
          escalationChannelId: body.escalationChannelId === undefined
            ? previousBinding?.escalationChannelId ?? null
            : body.escalationChannelId,
          gapEscalationEnabled: body.gapEscalationEnabled ?? previousBinding?.gapEscalationEnabled ?? false,
        };
        slackBindings = [
          ...slackBindings.filter((binding) => binding.channelId !== channelId),
          nextBinding,
        ].sort((left, right) => {
          if (left.channelId === null && right.channelId !== null) return -1;
          if (left.channelId !== null && right.channelId === null) return 1;
          return (left.channelId ?? "").localeCompare(right.channelId ?? "");
        });
        if (channelId === null) {
          slackBinding = nextBinding;
        }
        slackStatus = {
          ...slackStatus,
          readiness: slackStatus.readiness ?? slackReady,
          answeringAgentId: slackBinding.answeringAgentId ?? undefined,
        };
        await json(route, nextBinding);
        return;
      }

      if (request.method() === "DELETE") {
        const channelId = url.searchParams.get("channelId");
        options.slackRequests?.push({ method: request.method(), path, body: { channelId } });
        slackBindings = slackBindings.filter((binding) => binding.channelId === null || binding.channelId !== channelId);
        await route.fulfill({ status: 204 });
        return;
      }
    }

    if (path === `/workspaces/${workspaceId}/slack/installation` && request.method() === "DELETE") {
      options.slackRequests?.push({ method: request.method(), path });
      slackStatus = { status: "not_configured", readiness: slackReady };
      slackBinding = { channelId: null, answeringAgentId: null, escalationChannelId: null, gapEscalationEnabled: false };
      slackBindings = [slackBinding];
      slackSkills = [];
      await route.fulfill({ status: 204 });
      return;
    }

    if (path === `/agents/${defaultAgentId}/slack-skills`) {
      if (request.method() === "GET") {
        await json(route, { skills: slackSkills });
        return;
      }

      if (request.method() === "POST") {
        const body = request.postDataJSON() as Omit<SlackSkillFixture, "id" | "workspaceId" | "agentId" | "outcomes" | "createdAt" | "updatedAt">;
        options.slackRequests?.push({ method: request.method(), path, body });
        const skill: SlackSkillFixture = {
          id: `77777777-7777-4777-8777-${String(nextSlackSkillIndex).padStart(12, "0")}`,
          workspaceId,
          agentId: defaultAgentId,
          skillName: body.skillName,
          installationId: body.installationId,
          boundInputs: body.boundInputs ?? {},
          exposedInputs: body.exposedInputs ?? {},
          enabled: body.enabled ?? true,
          outcomes: ["enqueued", "missing_input", "failed"],
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        nextSlackSkillIndex += 1;
        slackSkills = [...slackSkills, skill];
        await json(route, { skill }, 201);
        return;
      }
    }

    if (path.startsWith(`/agents/${defaultAgentId}/slack-skills/`)) {
      const skillId = path.replace(`/agents/${defaultAgentId}/slack-skills/`, "");
      const skill = slackSkills.find((item) => item.id === skillId);
      if (!skill) {
        await json(route, { error: { message: "Slack skill not found" } }, 404);
        return;
      }

      if (request.method() === "PATCH") {
        const body = request.postDataJSON() as Partial<SlackSkillFixture>;
        options.slackRequests?.push({ method: request.method(), path, body });
        slackSkills = slackSkills.map((item) => item.id === skillId ? { ...item, ...body, updatedAt: nowIso } : item);
        await json(route, { skill: slackSkills.find((item) => item.id === skillId) });
        return;
      }

      if (request.method() === "DELETE") {
        options.slackRequests?.push({ method: request.method(), path });
        slackSkills = slackSkills.filter((item) => item.id !== skillId);
        await route.fulfill({ status: 204 });
        return;
      }
    }

    if (request.method() === "POST" && path === `/agents/${defaultAgentId}/anonymous-chat-token/rotate`) {
      agentSettings = {
        ...agentSettings,
        surfaceSettings: {
          ...agentSettings.surfaceSettings,
          anonymousChat: {
            ...agentSettings.surfaceSettings.anonymousChat,
            token: "public-token-rotated",
          },
        },
        updatedAt: nowIso,
      };
      channelsLifecycle = {
        ...channelsLifecycle,
        anonymousChat: { lastUsedAt: null },
      };
      await json(route, agentSettings);
      return;
    }

    if (request.method() === "POST" && path === `/agents/${defaultAgentId}/website-embed-token/rotate`) {
      agentSettings = {
        ...agentSettings,
        surfaceSettings: {
          ...agentSettings.surfaceSettings,
          websiteEmbed: {
            ...agentSettings.surfaceSettings.websiteEmbed,
            token: "embed-token-rotated",
          },
        },
        updatedAt: nowIso,
      };
      channelsLifecycle = {
        ...channelsLifecycle,
        websiteEmbed: { lastUsedAt: null },
      };
      await json(route, agentSettings);
      return;
    }

    if (path === `/agents/${defaultAgentId}`) {
      if (request.method() === "GET") {
        await json(route, agentSettings);
        return;
      }

      if (request.method() === "PUT") {
        const body = request.postDataJSON() as Partial<typeof agentSettings> & {
          surfaceSettings?: {
            authenticatedChat?: Partial<typeof agentSettings.surfaceSettings.authenticatedChat>;
            anonymousChat?: Partial<typeof agentSettings.surfaceSettings.anonymousChat>;
            websiteEmbed?: Partial<typeof agentSettings.surfaceSettings.websiteEmbed>;
          };
        };
        agentUpdates?.push(body);
        agentSettings = {
          ...agentSettings,
          ...body,
          surfaceSettings: {
            authenticatedChat: {
              ...agentSettings.surfaceSettings.authenticatedChat,
              ...(body.surfaceSettings?.authenticatedChat ?? {}),
            },
            anonymousChat: {
              ...agentSettings.surfaceSettings.anonymousChat,
              ...(body.surfaceSettings?.anonymousChat ?? {}),
            },
            websiteEmbed: {
              ...agentSettings.surfaceSettings.websiteEmbed,
              ...(body.surfaceSettings?.websiteEmbed ?? {}),
            },
          },
          updatedAt: nowIso,
        };
        await json(route, agentSettings);
        return;
      }
    }

    if (path === `/agents/${defaultAgentId}/skill-capabilities` && request.method() === "GET") {
      await json(route, { capabilities: skillCapabilities });
      return;
    }

    if (path === `/agents/${defaultAgentId}/skills`) {
      if (request.method() === "GET") {
        await json(route, { skills: agentSkills });
        return;
      }

      if (request.method() === "POST") {
        const body = request.postDataJSON() as Omit<AgentSkillFixture, "id" | "workspaceId" | "agentId" | "storedKind" | "createdAt" | "updatedAt">;
        options.agentSkillRequests?.push({ method: request.method(), path, body });
        const capability = skillCapabilities.find((candidate) => candidate.id === body.capability);
        const skill: AgentSkillFixture = {
          id: `66666666-6666-4666-8666-${String(nextAgentSkillIndex).padStart(12, "0")}`,
          workspaceId,
          agentId: defaultAgentId,
          name: body.name,
          capability: body.capability,
          storedKind: capability?.storedKind ?? body.capability,
          target: body.target,
          config: body.config,
          invocationMode: body.invocationMode,
          enabled: body.enabled,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        nextAgentSkillIndex += 1;
        agentSkills = [skill, ...agentSkills];
        await json(route, { skill }, 201);
        return;
      }
    }

    if (path.startsWith(`/agents/${defaultAgentId}/skills/`)) {
      const skillId = path.replace(`/agents/${defaultAgentId}/skills/`, "");
      const skill = agentSkills.find((item) => item.id === skillId);
      if (!skill) {
        await json(route, { error: { code: "not_found", message: "Skill not found" } }, 404);
        return;
      }

      if (request.method() === "PATCH") {
        const body = request.postDataJSON() as Partial<AgentSkillFixture>;
        options.agentSkillRequests?.push({ method: request.method(), path, body });
        agentSkills = agentSkills.map((item) => item.id === skillId ? { ...item, ...body, updatedAt: nowIso } : item);
        await json(route, { skill: agentSkills.find((item) => item.id === skillId) });
        return;
      }

      if (request.method() === "DELETE") {
        options.agentSkillRequests?.push({ method: request.method(), path });
        agentSkills = agentSkills.filter((item) => item.id !== skillId);
        await route.fulfill({ status: 204 });
        return;
      }
    }

    if (path === "/context-variables") {
      if (request.method() === "GET") {
        await json(route, { contextVariables });
        return;
      }

      if (request.method() === "POST") {
        const body = request.postDataJSON() as ApiSchemas["ContextVariableCreateRequest"];
        contextVariableRequests?.push({ method: "POST", path, body });
        const contextVariable: ContextVariableFixture = {
          id: `88888888-8888-4888-8888-${String(nextContextVariableIndex).padStart(12, "0")}`,
          workspaceId,
          name: body.name,
          description: body.description ?? null,
          valueType: body.valueType,
          trustTier: body.trustTier,
          sensitivity: body.sensitivity,
          defaultSurfacing: body.defaultSurfacing,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        nextContextVariableIndex += 1;
        contextVariables = [...contextVariables, contextVariable];
        await json(route, { contextVariable }, 201);
        return;
      }
    }

    if (path.startsWith("/context-variables/")) {
      const variableId = path.replace("/context-variables/", "");
      const contextVariable = contextVariables.find((item) => item.id === variableId);
      if (!contextVariable) {
        await json(route, { error: { code: "not_found", message: "Context variable not found" } }, 404);
        return;
      }

      if (request.method() === "PATCH") {
        const body = request.postDataJSON() as ApiSchemas["ContextVariableUpdateRequest"];
        contextVariableRequests?.push({ method: "PATCH", path, body });
        contextVariables = contextVariables.map((item) =>
          item.id === variableId
            ? {
                ...item,
                ...body,
                description: body.description === undefined ? item.description : body.description,
                updatedAt: nowIso,
              }
            : item
        );
        await json(route, { contextVariable: contextVariables.find((item) => item.id === variableId) });
        return;
      }

      if (request.method() === "DELETE") {
        contextVariableRequests?.push({ method: "DELETE", path });
        contextVariables = contextVariables.filter((item) => item.id !== variableId);
        contextVariableEnablements = contextVariableEnablements.filter((item) => item.variableId !== variableId);
        await route.fulfill({ status: 204 });
        return;
      }
    }

    if (path === `/agents/${defaultAgentId}/context-variables`) {
      if (request.method() === "GET") {
        await json(route, {
          enablements: contextVariableEnablements.map((enablement) => ({
            ...enablement,
            variable: contextVariables.find((item) => item.id === enablement.variableId),
          })),
        });
        return;
      }
    }

    if (path.startsWith(`/agents/${defaultAgentId}/context-variables/`)) {
      const variableId = path.replace(`/agents/${defaultAgentId}/context-variables/`, "");
      const contextVariable = contextVariables.find((item) => item.id === variableId);
      if (!contextVariable) {
        await json(route, { error: { code: "not_found", message: "Context variable not found" } }, 404);
        return;
      }

      if (request.method() === "PUT") {
        const body = request.postDataJSON() as ApiSchemas["AgentContextVariableEnablementRequest"];
        contextVariableRequests?.push({ method: "PUT", path, body });
        const existing = contextVariableEnablements.find((item) => item.variableId === variableId);
        const enablement: AgentContextVariableEnablementFixture = {
          id: existing?.id ?? `99999999-9999-4999-9999-${String(nextContextVariableEnablementIndex).padStart(12, "0")}`,
          agentId: defaultAgentId,
          variableId,
          source: body.source,
          resolverSkillId: body.resolverSkillId ?? null,
          maxAgeSeconds: body.maxAgeSeconds ?? null,
          resolverTimeoutMs: body.resolverTimeoutMs ?? null,
          surfacing: body.surfacing,
          enabled: body.enabled ?? true,
          createdAt: existing?.createdAt ?? nowIso,
          updatedAt: nowIso,
          variable: contextVariable,
        };
        if (!existing) nextContextVariableEnablementIndex += 1;
        contextVariableEnablements = [
          ...contextVariableEnablements.filter((item) => item.variableId !== variableId),
          enablement,
        ];
        await json(route, { enablement });
        return;
      }

      if (request.method() === "DELETE") {
        contextVariableRequests?.push({ method: "DELETE", path });
        contextVariableEnablements = contextVariableEnablements.filter((item) => item.variableId !== variableId);
        await route.fulfill({ status: 204 });
        return;
      }
    }

    if (path === `/agents/${defaultAgentId}/directives`) {
      if (request.method() === "GET") {
        await json(route, { directives, builtIns });
        return;
      }

      if (request.method() === "POST") {
        const body = request.postDataJSON() as ApiSchemas["AuthoredDirectiveCreateRequest"];
        directiveUpdates?.push({ method: "POST", body });
        const directive = buildDirective({
          id: `44444444-4444-4444-8444-${String(nextDirectiveIndex).padStart(12, "0")}`,
          name: body.name,
          condition: body.condition,
          action: body.action,
          binding: body.binding ?? null,
          priority: body.priority ?? null,
          dependsOn: body.dependsOn ?? [],
          excludes: body.excludes ?? [],
          requiredCapabilities: body.requiredCapabilities ?? [],
          description: body.description ?? null,
          metadata: body.metadata ?? {},
          enabled: body.enabled ?? true,
        });
        nextDirectiveIndex += 1;
        directives = [...directives, directive];
        await json(route, {
          directive,
          coherence: coherenceFor(directive),
        }, 201);
        return;
      }
    }

    if (path.startsWith(`/agents/${defaultAgentId}/directives/`)) {
      const directiveId = path.replace(`/agents/${defaultAgentId}/directives/`, "");

      if (request.method() === "PATCH") {
        const body = request.postDataJSON() as ApiSchemas["AuthoredDirectiveUpdateRequest"];
        directiveUpdates?.push({ method: "PATCH", directiveId, body });
        const existing = directives.find((directive) => directive.id === directiveId);
        if (!existing) {
          await json(route, { error: { code: "not_found", message: "Directive not found" } }, 404);
          return;
        }
        const directive = {
          ...existing,
          ...body,
          condition: body.condition ?? existing.condition,
          updatedAt: nowIso,
        };
        directives = directives.map((item) => item.id === directiveId ? directive : item);
        await json(route, {
          directive,
          coherence: coherenceFor(directive),
        });
        return;
      }

      if (request.method() === "DELETE") {
        directiveUpdates?.push({ method: "DELETE", directiveId });
        directives = directives.filter((directive) => directive.id !== directiveId);
        await route.fulfill({ status: 204, contentType: "application/json", body: "" });
        return;
      }
    }

    if (path === `/agents/${defaultAgentId}/routines/draft-assist` && request.method() === "POST") {
      routineUpdates?.push({ method: "ASSIST", body: request.postDataJSON() });
      await json(route, options.routineDraftAssist ?? {
        draft: {
          name: "assisted-contact",
          activation: {
            triggerDescription: "Visitor asks for a person to follow up.",
            gateRef: null,
            priority: 0,
          },
          slots: [{
            stableSlotId: "email",
            key: "email",
            type: "email",
            required: true,
            description: "Visitor email",
            ordinal: 0,
          }],
          steps: [
            {
              stableStepId: "collect_email",
              kind: "chat",
              instruction: "Ask for {{slot.email}}.",
              toolRef: null,
              actionType: null,
              ordinal: 0,
              metadata: { outlineLabel: "Collect email" },
            },
            {
              stableStepId: "send_contact",
              kind: "action",
              instruction: "Send the contact request.",
              toolRef: null,
              actionType: "contact.send",
              ordinal: 1,
              metadata: { outlineLabel: "Send contact request" },
            },
          ],
          transitions: [
            {
              fromStep: "collect_email",
              toRef: "send_contact",
              guardKind: "default",
              guardText: null,
              outcomeStatus: null,
              counterLimit: null,
              ordinal: 0,
            },
            {
              fromStep: "send_contact",
              toRef: "done",
              guardKind: "default",
              guardText: null,
              outcomeStatus: null,
              counterLimit: null,
              ordinal: 1,
            },
          ],
          terminals: [{
            stableStepId: "done",
            kind: "complete",
            instruction: "Confirm the request is open.",
            ordinal: 0,
          }],
        },
        validation: { ok: true, diagnostics: [] },
      });
      return;
    }

    if (path === `/agents/${defaultAgentId}/email-skills` && request.method() === "GET") {
      await json(route, { skills: emailSkills });
      return;
    }

    if (path === `/agents/${defaultAgentId}/routine-skill-catalog` && request.method() === "GET") {
      await json(route, { skills: routineSkillCatalog });
      return;
    }

    if (path === `/workspaces/${workspaceId}/email-skill-activity` && request.method() === "GET") {
      await json(route, { activities: emailActivity });
      return;
    }

    if (path === `/agents/${defaultAgentId}/routines`) {
      if (request.method() === "GET") {
        await json(route, { routines });
        return;
      }

      if (request.method() === "POST") {
        const body = request.postDataJSON() as RoutineDraftFixture;
        routineUpdates?.push({ method: "POST", body });
        const routineId = `55555555-5555-4555-8555-${String(nextRoutineIndex).padStart(12, "0")}`;
        const routine = buildRoutine({
          ...body,
          id: routineId,
          lineageId: routineId,
        });
        nextRoutineIndex += 1;
        routines = [...routines, routine];
        await json(route, {
          routine,
          validation: validateRoutineFixture(routine),
        }, 201);
        return;
      }
    }

    if (path.startsWith(`/agents/${defaultAgentId}/routines/`)) {
      const suffix = path.replace(`/agents/${defaultAgentId}/routines/`, "");
      const [routineId, action] = suffix.split("/");
      const existing = routines.find((routine) => routine.id === routineId);

      if (request.method() === "GET" && !action) {
        if (!existing) {
          await json(route, { error: { code: "not_found", message: "Routine not found" } }, 404);
          return;
        }
        await json(route, { routine: existing });
        return;
      }

      if (request.method() === "PATCH" && !action) {
        const body = request.postDataJSON() as RoutineDraftFixture;
        routineUpdates?.push({ method: "PATCH", routineId, body });
        if (!existing || existing.status !== "draft") {
          await json(route, { error: { code: "not_found", message: "Draft routine not found" } }, 404);
          return;
        }
        const routine: RoutineFixture = {
          ...existing,
          ...body,
          updatedAt: nowIso,
        };
        routines = routines.map((item) => item.id === routineId ? routine : item);
        await json(route, {
          routine,
          validation: validateRoutineFixture(routine),
        });
        return;
      }

      if (request.method() === "DELETE" && !action) {
        routineUpdates?.push({ method: "DELETE", routineId });
        routines = routines.filter((routine) => routine.id !== routineId);
        await route.fulfill({ status: 204, contentType: "application/json", body: "" });
        return;
      }

      if (request.method() === "POST" && action === "validate") {
        routineUpdates?.push({ method: "VALIDATE", routineId });
        if (!existing) {
          await json(route, { error: { code: "not_found", message: "Routine not found" } }, 404);
          return;
        }
        await json(route, { validation: validateRoutineFixture(existing) });
        return;
      }

      if (request.method() === "POST" && action === "publish") {
        routineUpdates?.push({ method: "PUBLISH", routineId });
        if (!existing || existing.status !== "draft") {
          await json(route, { error: { code: "not_found", message: "Draft routine not found" } }, 404);
          return;
        }
        const validation = validateRoutineFixture(existing);
        if (!validation.ok) {
          await json(route, { error: "Routine definition is invalid", validation }, 422);
          return;
        }
        const published: RoutineFixture = {
          ...existing,
          status: "published",
          updatedAt: nowIso,
        };
        routines = routines
          .map((routine) => routine.id === routineId
            ? published
            : routine.lineageId === existing.lineageId && routine.status === "published"
            ? { ...routine, status: "superseded", updatedAt: nowIso }
            : routine);
        await json(route, { routine: published, validation, directiveScopeOrphans: [] });
        return;
      }

      if (request.method() === "POST" && action === "revise") {
        routineUpdates?.push({ method: "REVISE", routineId });
        if (!existing || existing.status !== "published") {
          await json(route, { error: { code: "not_found", message: "Published routine not found" } }, 404);
          return;
        }
        const currentDraft = routines.find((routine) => routine.lineageId === existing.lineageId && routine.status === "draft");
        if (currentDraft) {
          await json(route, { routine: currentDraft });
          return;
        }
        const draft: RoutineFixture = {
          ...existing,
          id: `55555555-5555-4555-8555-${String(nextRoutineIndex).padStart(12, "0")}`,
          status: "draft",
          version: Math.max(...routines.filter((routine) => routine.lineageId === existing.lineageId).map((routine) => routine.version), 0) + 1,
          updatedAt: nowIso,
        };
        nextRoutineIndex += 1;
        routines = [...routines, draft];
        await json(route, { routine: draft });
        return;
      }

      if (request.method() === "POST" && action === "archive") {
        routineUpdates?.push({ method: "ARCHIVE", routineId });
        if (!existing || existing.status !== "published") {
          await json(route, { error: { code: "not_found", message: "Published routine not found" } }, 404);
          return;
        }
        const archived: RoutineFixture = { ...existing, status: "archived", updatedAt: nowIso };
        // Archiving retires the routine and discards any in-progress revision draft in the lineage.
        routines = routines
          .filter((routine) => !(routine.lineageId === existing.lineageId && routine.status === "draft"))
          .map((routine) => routine.id === routineId ? archived : routine);
        await json(route, { routine: archived });
        return;
      }

      if (request.method() === "POST" && action === "restore") {
        routineUpdates?.push({ method: "RESTORE", routineId });
        if (!existing || existing.status !== "archived") {
          await json(route, { error: { code: "not_found", message: "Archived routine not found" } }, 404);
          return;
        }
        const hasPublishedInLineage = routines.some((routine) =>
          routine.lineageId === existing.lineageId &&
          routine.id !== existing.id &&
          routine.status === "published"
        );
        if (hasPublishedInLineage) {
          await json(route, {
            error: {
              code: "bad_request",
              message: "Archived routine definition cannot be restored while another version is published",
            },
          }, 400);
          return;
        }
        const restored: RoutineFixture = { ...existing, status: "published", updatedAt: nowIso };
        routines = routines.map((routine) => routine.id === routineId ? restored : routine);
        await json(route, { routine: restored });
        return;
      }
    }

    if (path === "/settings/webhook-destinations") {
      if (request.method() === "GET") {
        await json(route, { destinations: webhookDestinations });
        return;
      }

      if (request.method() === "POST") {
        const body = request.postDataJSON() as ApiSchemas["WebhookDestinationRequest"];
        webhookDestinationUpdates?.push({ method: "POST", body });
        if (webhookDestinations.some((destination) => destination.name.toLowerCase() === body.name.toLowerCase())) {
          await json(route, { error: { code: "conflict", message: `Webhook destination named "${body.name}" already exists in this workspace` } }, 409);
          return;
        }
        const destination: WebhookDestinationFixture = {
          id: `33333333-3333-4333-8333-${String(nextWebhookDestinationIndex).padStart(12, "0")}`,
          name: body.name,
          url: body.url,
          lastDeliveryStatus: null,
          lastDeliveryAt: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        nextWebhookDestinationIndex += 1;
        webhookDestinations = [...webhookDestinations, destination];
        await json(route, { destination, secret: `whsec_${destination.id.slice(-6)}` }, 201);
        return;
      }
    }

    if (path.startsWith("/settings/webhook-destinations/")) {
      const suffix = path.replace("/settings/webhook-destinations/", "");
      const [destinationId, action] = suffix.split("/");
      const existing = webhookDestinations.find((destination) => destination.id === destinationId);

      if (request.method() === "GET" && !action) {
        if (!existing) {
          await json(route, { error: { code: "not_found", message: "Webhook destination not found" } }, 404);
          return;
        }
        await json(route, { destination: existing });
        return;
      }

      if (request.method() === "PUT" && !action) {
        const body = request.postDataJSON() as ApiSchemas["WebhookDestinationRequest"];
        webhookDestinationUpdates?.push({ method: "PUT", destinationId, body });
        if (!existing) {
          await json(route, { error: { code: "not_found", message: "Webhook destination not found" } }, 404);
          return;
        }
        const destination = { ...existing, name: body.name, url: body.url, updatedAt: nowIso };
        webhookDestinations = webhookDestinations.map((item) => item.id === destinationId ? destination : item);
        await json(route, { destination });
        return;
      }

      if (request.method() === "POST" && action === "rotate-secret") {
        webhookDestinationUpdates?.push({ method: "ROTATE_SECRET", destinationId });
        if (!existing) {
          await json(route, { error: { code: "not_found", message: "Webhook destination not found" } }, 404);
          return;
        }
        await json(route, { destination: { ...existing, updatedAt: nowIso }, secret: `whsec_rotated_${destinationId.slice(-6)}` });
        return;
      }

      if (request.method() === "DELETE" && !action) {
        webhookDestinationUpdates?.push({ method: "DELETE", destinationId });
        webhookDestinations = webhookDestinations.filter((destination) => destination.id !== destinationId);
        await route.fulfill({ status: 204, contentType: "application/json", body: "" });
        return;
      }
    }

    if (request.method() === "GET" && path === "/settings") {
      await json(route, platformSettings);
      return;
    }

    if (request.method() === "GET" && path === "/settings/retrieval-defaults") {
      await json(route, retrievalDefaults);
      return;
    }

    if (request.method() === "GET" && path === "/settings/credentials") {
      await json(route, {
        encryptionConfigured: providerEncryptionConfigured,
        credentials: Object.entries(providerCredentials)
          .filter(([, value]) => value !== null)
          .map(([provider, value]) => ({ provider, updatedAt: value!.updatedAt })),
        envProviderAvailability: {
          openai: true,
          "openai-compatible": true,
          gemini: true,
          claude: true,
        },
      });
      return;
    }

    if (request.method() === "PUT" && path.startsWith("/settings/credentials/")) {
      const provider = path.replace("/settings/credentials/", "");
      providerCredentials[provider] = { updatedAt: new Date().toISOString() };
      providerCredentialUpdates?.push({ method: "PUT", provider, body: request.postDataJSON() });
      await route.fulfill({ status: 204, contentType: "application/json", body: "" });
      return;
    }

    if (request.method() === "DELETE" && path.startsWith("/settings/credentials/")) {
      const provider = path.replace("/settings/credentials/", "");
      providerCredentials[provider] = null;
      providerCredentialUpdates?.push({ method: "DELETE", provider });
      await route.fulfill({ status: 204, contentType: "application/json", body: "" });
      return;
    }

    if (request.method() === "GET" && path === "/settings/llm-models") {
      await json(route, { ...llmModels, knownModelsByProvider });
      return;
    }

    if (request.method() === "PUT" && path === "/settings/llm-models") {
      const body = request.postDataJSON() as Partial<typeof llmModels>;
      llmModelUpdates?.push(body);
      llmModels = {
        chat: 'chat' in body ? body.chat ?? null : llmModels.chat,
        rewrite: 'rewrite' in body ? body.rewrite ?? null : llmModels.rewrite,
        rerank: 'rerank' in body ? body.rerank ?? null : llmModels.rerank,
      };
      await json(route, { ...llmModels, knownModelsByProvider });
      return;
    }

    if (request.method() === "GET" && path === "/settings/ingestion/embedding-coverage") {
      await json(route, options.embeddingCoverage ?? baseEmbeddingCoverage());
      return;
    }

    if (request.method() === "GET" && path === "/settings/ingestion") {
      await json(route, ingestionSettings);
      return;
    }

    if (request.method() === "PUT" && path === "/settings/ingestion") {
      const body = request.postDataJSON() as Partial<IngestionSettingsFixture>;
      ingestionSettingsUpdates?.push(body);
      if (options.ingestionSettingsUpdateError) {
        await json(route, {
          error: {
            code: "embedding_transition_failed",
            message: options.ingestionSettingsUpdateError,
          },
        }, 503);
        return;
      }
      const requestedEmbeddingModel = body.embeddingModel;
      const supportedEmbeddingModel = ingestionSettings.supportedEmbeddingModels.find(
        (model) => model === requestedEmbeddingModel,
      );
      const embeddingFields =
        supportedEmbeddingModel && supportedEmbeddingModel !== ingestionSettings.embeddingModel
          ? {
              embeddingModel: ingestionSettings.embeddingModel,
              pendingEmbeddingModel: supportedEmbeddingModel,
            }
          : {
              embeddingModel: requestedEmbeddingModel ?? ingestionSettings.embeddingModel,
            };
      ingestionSettings = {
        ...ingestionSettings,
        ...body,
        ...embeddingFields,
        updatedAt: nowIso,
      };
      await json(route, ingestionSettings);
      return;
    }

    if (request.method() === "GET" && path === "/settings/document-types") {
      await json(route, documentTypeCatalog);
      return;
    }

    if (request.method() === "PUT" && path === "/settings/document-types") {
      const body = request.postDataJSON() as ApiSchemas["UpdateDocumentTypeCatalogRequest"];
      documentTypeCatalogUpdates?.push(body);

      if (documentTypeCatalogStaleRevisionPending) {
        // A concurrent editor already moved the revision on; the next GET serves it.
        documentTypeCatalogStaleRevisionPending = false;
        documentTypeCatalog = {
          ...documentTypeCatalog,
          revision: String(Number(documentTypeCatalog.revision) + 1),
        };
        await json(route, {
          error: {
            code: "conflict",
            message: `The document type catalog changed since it was loaded (current revision ${documentTypeCatalog.revision}). Reload before saving again.`,
          },
        }, 409);
        return;
      }

      const builtIns = documentTypeCatalog.types.filter((type) => type.origin === "built_in");
      const disabled = new Set(body.disabledBuiltInTypeKeys ?? []);
      documentTypeCatalog = {
        ...documentTypeCatalog,
        revision: String(Number(documentTypeCatalog.revision) + 1),
        types: [
          ...builtIns.map((type) => ({
            ...type,
            enabled: type.disableable ? !disabled.has(type.key) : true,
          })),
          ...(body.types ?? []).map((type) => ({
            key: type.key,
            label: type.label,
            description: type.description ?? "",
            enabled: type.enabled ?? true,
            origin: "operator" as const,
            payload: "fields" as const,
            disableable: true,
            fields: (type.fields ?? []).map((field) => ({ ...field, instruction: field.instruction ?? "" })),
          })),
        ],
      };
      await json(route, documentTypeCatalog);
      return;
    }

    if (request.method() === "POST" && path === "/settings/ingestion/embedding-model/cancel") {
      ingestionSettings = {
        ...ingestionSettings,
        pendingEmbeddingModel: null,
        updatedAt: nowIso,
      };
      await json(route, ingestionSettings);
      return;
    }

    if (request.method() === "PUT" && path === "/settings") {
      const body = request.postDataJSON() as Partial<PlatformSettingsFixture>;
      settingsUpdates?.push(body);
      platformSettings = {
        assistant: {
          ...platformSettings.assistant,
          ...(body.assistant ?? {}),
        },
        channels: {
          ...platformSettings.channels,
          ...(body.channels ?? {}),
        },
      };
      await json(route, platformSettings);
      return;
    }

    if (request.method() === "GET" && path === `/agents/${defaultAgentId}/mcp-connections`) {
      await json(route, { connections: mcpConnections });
      return;
    }

    if (request.method() === "GET" && path === `/agents/${defaultAgentId}/channel-credentials`) {
      const audience = new URL(request.url()).searchParams.get("audience");
      agentChannelCredentialRequests?.push({ method: "GET", path });
      await json(route, { credentials: agentChannelCredentials.filter((credential) => !audience || credential.audience === audience) });
      return;
    }

    if (request.method() === "POST" && path === `/agents/${defaultAgentId}/channel-credentials`) {
      const body = request.postDataJSON() as { audience: "mcp" | "rest"; label: string; expiresAt: string };
      agentChannelCredentialRequests?.push({ method: "POST", path, body });
      const token = `radioso_${body.audience}_${nextAgentChannelCredentialIndex}_plaintext`;
      const credential: AgentChannelCredentialFixture = {
        id: `agent-channel-credential-${nextAgentChannelCredentialIndex++}`,
        audience: body.audience,
        label: body.label,
        prefix: token.slice(0, 18),
        status: "active",
        createdAt: nowIso,
        expiresAt: body.expiresAt,
        lastUsedAt: null,
        revokedAt: null,
      };
      agentChannelCredentials = [credential, ...agentChannelCredentials];
      await json(route, { credential, secret: token }, 201);
      return;
    }

    if (request.method() === "POST" && /\/agents\/[^/]+\/channel-credentials\/[^/]+\/rotate$/.test(path)) {
      const credentialId = path.split("/")[4];
      agentChannelCredentialRequests?.push({ method: "POST", path });
      const credential = agentChannelCredentials.find((entry) => entry.id === credentialId);
      const token = `radioso_agent_rotated_${credentialId}`;
      if (credential) {
        credential.prefix = token.slice(0, 18);
        credential.createdAt = nowIso;
      }
      await json(route, { credential, secret: token });
      return;
    }

    if (request.method() === "POST" && /\/agents\/[^/]+\/channel-credentials\/[^/]+\/revoke$/.test(path)) {
      const credentialId = path.split("/")[4];
      agentChannelCredentialRequests?.push({ method: "POST", path });
      agentChannelCredentials = agentChannelCredentials.map((credential) => credential.id === credentialId
        ? { ...credential, status: "revoked", revokedAt: nowIso }
        : credential);
      await route.fulfill({ status: 204, contentType: "application/json", body: "" });
      return;
    }

    if (request.method() === "GET" && path === `/agents/${defaultAgentId}/external-skills`) {
      await json(route, { skills: [] });
      return;
    }

    if (request.method() === "POST" && path === `/agents/${defaultAgentId}/mcp-connections`) {
      const body = request.postDataJSON() as { displayName: string; serverUrl: string; authMethod: string };
      mcpConnectionRequests?.push(`POST ${path}`);
      const connection: McpConnectionFixture = {
        id: `mcp-connection-${nextMcpConnectionIndex++}`,
        displayName: body.displayName,
        serverUrl: body.serverUrl,
        authMethod: body.authMethod,
        status: body.authMethod === "oauth" ? "unconfigured" : "authorized",
        hasCredential: body.authMethod !== "oauth",
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      mcpConnections.unshift(connection);
      await json(route, connection, 201);
      return;
    }

    if (request.method() === "POST" && /\/agents\/[^/]+\/mcp-connections\/[^/]+\/discover$/.test(path)) {
      mcpConnectionRequests?.push(`POST ${path}`);
      await json(route, { tools: mcpDiscoveredTools });
      return;
    }

    if (request.method() === "POST" && /\/agents\/[^/]+\/mcp-connections\/[^/]+\/oauth\/authorize$/.test(path)) {
      mcpConnectionRequests?.push(`POST ${path}`);
      await json(route, {
        authorizationUrl: "https://auth.example.com/authorize?response_type=code&state=test-state",
      });
      return;
    }

    if (request.method() === "POST" && /\/agents\/[^/]+\/mcp-connections\/([^/]+)\/oauth\/complete$/.test(path)) {
      const connectionId = path.split("/")[4];
      mcpConnectionRequests?.push(`POST ${path}`);
      const connection = mcpConnections.find((entry) => entry.id === connectionId);
      if (connection) {
        connection.status = "authorized";
        connection.hasCredential = true;
      }
      await json(route, connection ?? {}, 200);
      return;
    }

    await json(route, { error: { code: "not_found", message: `Unhandled mock route: ${request.method()} ${path}` } }, 404);
  });
};
