import type { Page, Route } from "@playwright/test";
import type { components } from "../../../typescript-sdk/src/generated/types";

type ApiSchemas = components["schemas"];

export const workspaceId = "workspace-1";
export const workspaceKey = "workspace-key";
export const accountId = "account-1";
export const defaultAgentId = "67acb0c8-caad-4a1b-9fef-70cbca3f7d12";

export const nowIso = "2026-04-26T12:00:00.000Z";

type AuthoredDirectiveFixture = ApiSchemas["AuthoredDirective"];
type BuiltInDirectiveFixture = ApiSchemas["BuiltInDirective"];
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
  body?: unknown;
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
    window.localStorage.setItem("radioso.workspaceTokens", JSON.stringify({ [workspaceIdValue]: "workspace-token" }));
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
  routes: [],
  tags: [],
  description: null,
  metadata: {},
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
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ],
});

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
    agentUpdates?: unknown[];
    directiveUpdates?: DirectiveMutationFixture[];
    directives?: AuthoredDirectiveFixture[];
    builtIns?: BuiltInDirectiveFixture[];
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
    usageTrends?: unknown;
    mcpConnections?: McpConnectionFixture[];
    mcpConnectionRequests?: string[];
  } = {},
) => {
  let platformSettings = options.platformSettings ?? basePlatformSettings();
  const retrievalDefaults = options.retrievalDefaults ?? baseRetrievalDefaults();
  let ingestionSettings = options.ingestionSettings ?? baseIngestionSettings();
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
    gemini: ["gemini-2.5-flash", "gemini-2.5-pro"],
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
  let directives = options.directives ?? [];
  const builtIns = options.builtIns ?? baseBuiltInDirectives();
  let nextDirectiveIndex = 1;
  const directiveUpdates = options.directiveUpdates;
  let routines = options.routines ?? [];
  let nextRoutineIndex = 1;
  const routineUpdates = options.routineUpdates;
  let webhookDestinations = options.webhookDestinations ?? [];
  let nextWebhookDestinationIndex = webhookDestinations.length + 1;
  const mcpConnections = options.mcpConnections ?? [];
  const mcpConnectionRequests = options.mcpConnectionRequests;
  let nextMcpConnectionIndex = mcpConnections.length + 1;
  const webhookDestinationUpdates = options.webhookDestinationUpdates;
  const coherenceFor = (directive: AuthoredDirectiveFixture): ApiSchemas["DirectiveCoherenceVerdict"] => {
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

    if (request.method() === "GET" && path === `/account/workspaces/${workspaceId}/token`) {
      await json(route, { token: "workspace-token" });
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
      await json(route, historyItems);
      return;
    }

    if (request.method() === "GET" && path === "/history/chat") {
      await json(route, historyList);
      return;
    }

    if (request.method() === "GET" && path === "/history/search") {
      await json(route, searchHistory);
      return;
    }

    if (request.method() === "GET" && path.startsWith("/history/chat/") && options.conversationDetail) {
      await json(route, options.conversationDetail);
      return;
    }

    if (request.method() === "GET" && path === "/agents") {
      await json(route, { agents: [agentSettings] });
      return;
    }

    if (request.method() === "GET" && path === `/agents/${defaultAgentId}/channels/lifecycle`) {
      await json(route, channelsLifecycle);
      return;
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
          dependsOn: body.dependsOn ?? [],
          excludes: body.excludes ?? [],
          requiredCapabilities: body.requiredCapabilities ?? [],
          description: body.description ?? null,
          metadata: body.metadata ?? {},
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
        routines = routines.map((routine) => routine.id === routineId ? archived : routine);
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

    if (request.method() === "GET" && path === "/settings/ingestion") {
      await json(route, ingestionSettings);
      return;
    }

    if (request.method() === "PUT" && path === "/settings/ingestion") {
      const body = request.postDataJSON() as Partial<IngestionSettingsFixture>;
      ingestionSettingsUpdates?.push(body);
      const requestedEmbeddingModel = body.embeddingModel;
      const embeddingFields =
        requestedEmbeddingModel && requestedEmbeddingModel !== ingestionSettings.embeddingModel
          ? {
              embeddingModel: ingestionSettings.embeddingModel,
              pendingEmbeddingModel: requestedEmbeddingModel,
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
