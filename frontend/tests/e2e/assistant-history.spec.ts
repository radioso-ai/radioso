import { expect, test } from "@playwright/test";

import {
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

test("shared activity navigation shows assistant route diagnostics", async ({ page }) => {
  const conversationId = "conversation-1";
  const assistantMessageId = "assistant-message-1";
  const historyList = {
    conversations: [
      {
        id: conversationId,
        sourceChannel: null,
        sourceOrigin: null,
        anonymousSessionId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        messageCount: 2,
        userMessageCount: 1,
        assistantMessageCount: 1,
        preview: "What courses are coming up next month?",
      },
    ],
    total: 1,
    nextCursor: null,
    hasMore: false,
  };
  const conversationDetail = {
    conversationId,
    workspaceId,
    sourceChannel: null,
    sourceOrigin: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    messagesTotal: 2,
    messageWindowOffset: 0,
    messageWindowLimit: 50,
    hasOlderMessages: false,
    nextCursor: null,
    messages: [
      {
        id: "user-message-1",
        role: "user",
        content: "What courses are coming up next month?",
        createdAt: nowIso,
      },
      {
        id: assistantMessageId,
        role: "assistant",
        content: "Preparation includes:\n\n- Daily meditation\n- Advanced techniques",
        createdAt: nowIso,
        citations: [
          {
            documentId: "doc-1",
            chunkId: "chunk-1",
            title: "Course Calendar",
            quote: "Advanced techniques",
          },
        ],
        answerSegments: [
          {
            text: "Preparation includes:\n\n- Daily meditation\n- Advanced techniques",
          },
          {
            text: "\n\n",
            citationIndices: [0],
          },
        ],
        debug: {
          eventStatus: "success",
          recordedAt: nowIso,
          stream: false,
          citationCount: 1,
          answerOutcome: "grounded_success",
          activitySummary: {
            execution: {
              surface: "assistant",
              path: "assistant_retrieval",
              retrievalInvoked: true,
            },
            candidateCounts: {
              semantic: 1,
              lexical: 1,
              merged: 1,
              final: 1,
            },
            fallbackApplied: false,
            rerankStatus: "skipped",
            rewrite: {
              status: "skipped",
              eligible: false,
              ran: false,
              materialDisagreement: false,
            },
          },
          activityTrace: {
            traceId: "trace-1",
            startedAt: nowIso,
            completedAt: nowIso,
            totalDurationMs: 12,
            summary: {
              execution: {
                surface: "assistant",
                path: "assistant_retrieval",
                retrievalInvoked: true,
              },
              candidateCounts: {
                semantic: 1,
                lexical: 1,
                merged: 1,
                final: 1,
              },
              fallbackApplied: false,
              rerankStatus: "skipped",
            },
            stages: [
              {
                stageId: "context",
                kind: "context",
                label: "Context",
                status: "applied",
                metrics: { selectedHistoryCount: 1 },
              },
              {
                stageId: "routing",
                kind: "routing",
                label: "Routing",
                status: "applied",
                outputs: {
                  responseIntent: "retrieval",
                  retrievalInvoked: true,
                  retrievalSkipped: false,
                },
                reason: "evidence_required",
              },
              {
                stageId: "generation",
                kind: "generation",
                label: "Generation",
                status: "applied",
                metrics: { latencyMs: 12 },
              },
              {
                stageId: "answer",
                kind: "answer_outcome",
                label: "Answer outcome",
                status: "applied",
                outputs: { outcome: "grounded_success" },
              },
            ],
            links: [
              { fromStageId: "context", toStageId: "routing", kind: "sequence" },
              { fromStageId: "routing", toStageId: "generation", kind: "sequence" },
              { fromStageId: "generation", toStageId: "answer", kind: "sequence" },
            ],
          },
          route: {
            generator: "assistant",
            routeType: "retrieval",
            routeReason: "evidence_required",
            retrievalInvoked: true,
          },
        },
      },
    ],
  };
  const requestLog: string[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList,
    conversationDetail,
    requestLog,
  });

  await page.goto(`/w/${workspaceKey}/activity`);

  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Activity" })).toBeVisible();
  expect(requestLog).toContain("GET /history?limit=50&offset=0");
  expect(requestLog).not.toContain("GET /history/chat?limit=50&offset=0");
  expect(requestLog).not.toContain("GET /history/search?limit=50&offset=0");
  await page.getByRole("button", { name: /What courses are coming up next month/ }).click();

  await expect(page).toHaveURL(/itemKind=chat/);
  await expect(
    page.locator("li").filter({ hasText: "Advanced techniques" }).getByRole("button", { name: /Open source 1/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Debug" }).click();
  await expect(page.getByText("Route", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Context/ })).toBeVisible();
  await expect(page.getByText("retrieval").first()).toBeVisible();
  await expect(page.getByText("evidence needed")).toBeVisible();
});

test("activity filtered pages request one offset-backed page", async ({ page }) => {
  const requestLog: string[] = [];
  const historyList = {
    conversations: [],
    total: 151,
    nextCursor: null,
    hasMore: false,
  };
  const searchHistory = {
    searches: [],
    total: 101,
    nextCursor: null,
    hasMore: false,
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList,
    requestLog,
    searchHistory,
  });

  await page.goto(`/w/${workspaceKey}/activity?filter=chat&page=3`);
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();

  expect(requestLog).toContain("GET /history/chat?limit=50&offset=100");
  expect(requestLog).not.toContain("GET /history/chat?limit=50&offset=0");
  expect(requestLog).not.toContain("GET /history?limit=50&offset=100");

  requestLog.length = 0;
  await page.goto(`/w/${workspaceKey}/activity?filter=search&page=2`);
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();

  expect(requestLog).toContain("GET /history/search?limit=50&offset=50");
  expect(requestLog).not.toContain("GET /history/search?limit=50&offset=0");
  expect(requestLog).not.toContain("GET /history?limit=50&offset=50");
});

test("documents direct page links request only the target offset page", async ({ page }) => {
  const requestLog: string[] = [];
  const documentList = {
    documents: [],
    total: 250,
    nextCursor: null,
    hasMore: false,
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { documentList, requestLog });

  await page.goto(`/w/${workspaceKey}/knowledge?page=3`);
  await expect(page.getByRole("heading", { name: "Documents", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Documents" })).toBeVisible();

  expect(requestLog).toContain("GET /document/?limit=100&offset=200");
  expect(requestLog).not.toContain("GET /document/?limit=100&offset=100");
  expect(requestLog.some((request) => request.startsWith("GET /document/?limit=100&cursor="))).toBe(false);
});
