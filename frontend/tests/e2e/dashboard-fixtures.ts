import type { Page, Route } from "@playwright/test";

export const workspaceId = "workspace-1";
export const workspaceKey = "workspace-key";
export const accountId = "account-1";

export const nowIso = "2026-04-26T12:00:00.000Z";

export const basePlatformSettings = () => ({
  assistant: {
    assistantName: "Marta",
    assistantRole: "Document guide",
    greetingInstruction: "",
    assistantDefaultLocale: "en-US",
    proactiveGreetingEnabled: true,
    assistantBootstrapActive: true,
    conversationMode: "guided",
    suggestedQuestionsEnabled: true,
    suggestedQuestionsCount: 3,
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
    citationDisplayEnabled: true,
    metadataFieldSuggestions: [],
    metadataRules: [],
  },
  channels: {
    anonymousChatEnabled: false,
    anonymousChatUrl: "http://localhost:3000/chat/public-token",
    anonymousRateLimit: 20,
    websiteEmbedEnabled: false,
    websiteEmbedToken: "embed-token",
    websiteEmbedScriptUrl: "http://localhost:3000/embed.js",
    websiteEmbedSnippet: "<script src=\"http://localhost:3000/embed.js\"></script>",
    websiteEmbedAllowedOrigins: [],
    websiteEmbedLauncherLabel: "Chat with us",
    websiteEmbedLauncherIcon: "chat",
    websiteEmbedLauncherPosition: "bottom-right",
  },
});

export type PlatformSettingsFixture = ReturnType<typeof basePlatformSettings>;

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

export const installDashboardApiMocks = async (
  page: Page,
  options: {
    platformSettings?: PlatformSettingsFixture;
    settingsUpdates?: unknown[];
    historyList?: unknown;
    conversationDetail?: unknown;
  } = {},
) => {
  let platformSettings = options.platformSettings ?? basePlatformSettings();
  const settingsUpdates = options.settingsUpdates;
  const historyList = options.historyList ?? {
    conversations: [],
    total: 0,
    nextCursor: null,
    hasMore: false,
  };

  await page.route("**/backend/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/backend\/api\/v1/, "");

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
      await json(route, documentListResponse);
      return;
    }

    if (request.method() === "GET" && path === "/document/search/history") {
      await json(route, emptySearchHistory);
      return;
    }

    if (request.method() === "GET" && path === "/history") {
      await json(route, historyList);
      return;
    }

    if (request.method() === "GET" && path.startsWith("/history/") && options.conversationDetail) {
      await json(route, options.conversationDetail);
      return;
    }

    if (request.method() === "GET" && path === "/settings") {
      await json(route, platformSettings);
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
