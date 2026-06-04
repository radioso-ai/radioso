import type { Page, Route } from "@playwright/test";
import type { components } from "../../../typescript-sdk/src/generated/types";

type ApiSchemas = components["schemas"];

export const workspaceId = "workspace-1";
export const workspaceKey = "workspace-key";
export const accountId = "account-1";
export const defaultAgentId = "67acb0c8-caad-4a1b-9fef-70cbca3f7d12";

export const nowIso = "2026-04-26T12:00:00.000Z";

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
  retrieval: {
    queryRewriteEnabled: false,
    semanticRewriteInstructions: "Keep semantic rewrites standalone.",
    lexicalRewriteInstructions: "Prefer exact phrases.",
    rerankEnabled: false,
    vectorTopK: 20,
    similarityThreshold: 0.2,
    rerankTopK: 5,
    retrievalStrategy: "fixed",
    metadataFieldSuggestions: [
      { field: "region", inferredType: "string" },
      { field: "publishedAt", inferredType: "date" },
    ],
    metadataRules: [],
  },
  channels: {
    anonymousChatEnabled: false,
    anonymousChatUrl: "http://localhost:3000/chat/public-token",
    websiteEmbedEnabled: false,
    websiteEmbedToken: "embed-token",
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
    documentList?: unknown;
    documentDetails?: Record<string, Record<string, unknown>>;
    settingsUpdates?: unknown[];
    workspaceSummary?: unknown;
    historyList?: unknown;
    historyItems?: unknown;
    searchHistory?: unknown;
    conversationDetail?: unknown;
    agentUpdates?: unknown[];
    requestLog?: string[];
    providerEncryptionConfigured?: boolean;
    providerCredentialUpdates?: Array<{ method: "PUT" | "DELETE"; provider: string; body?: unknown }>;
    llmModelUpdates?: Array<unknown>;
    ingestionSettings?: IngestionSettingsFixture;
    ingestionSettingsUpdates?: unknown[];
  } = {},
) => {
  let platformSettings = options.platformSettings ?? basePlatformSettings();
  let ingestionSettings = options.ingestionSettings ?? baseIngestionSettings();
  let agentSettings = buildDefaultAgentSettings(platformSettings);
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
  const historyList = options.historyList ?? {
    conversations: [],
    total: 0,
    nextCursor: null,
    hasMore: false,
  };
  const searchHistory = options.searchHistory ?? emptySearchHistory;
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

    if (request.method() === "GET" && path === `/account/workspaces/${workspaceId}/token`) {
      await json(route, { token: "workspace-token" });
      return;
    }

    if (request.method() === "GET" && path === "/document/") {
      await json(route, documents);
      return;
    }

    if (request.method() === "GET" && path === "/document/sources") {
      await json(route, emptyDocumentSources);
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

    if (request.method() === "GET" && path === "/settings") {
      await json(route, platformSettings);
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
        retrieval: {
          ...platformSettings.retrieval,
          ...(body.retrieval ?? {}),
        },
        channels: {
          ...platformSettings.channels,
          ...(body.channels ?? {}),
        },
      };
      await json(route, platformSettings);
      return;
    }

    await json(route, { error: { code: "not_found", message: `Unhandled mock route: ${request.method()} ${path}` } }, 404);
  });
};
