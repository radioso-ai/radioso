import { expect, test } from "@playwright/test";

import {
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

test("shared history navigation shows assistant route diagnostics", async ({ page }) => {
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
        content: "The advanced workshop runs next month.",
        createdAt: nowIso,
        citations: [
          {
            documentId: "doc-1",
            chunkId: "chunk-1",
            title: "Course Calendar",
            quote: "The advanced workshop runs next month.",
          },
        ],
        answerSegments: [
          {
            text: "The advanced workshop runs next month.",
            citationIndices: [0],
          },
        ],
        debug: {
          eventStatus: "success",
          recordedAt: nowIso,
          stream: false,
          citationCount: 1,
          answerOutcome: "grounded_success",
          conversationMode: "guided",
          conversationModeMetadata: {
            conversationMode: "guided",
            brevityOverrideApplied: false,
            expansionApplied: false,
            expansionKind: "none",
            suggestionCount: 0,
            followUpQuestionApplied: false,
          },
          validation: {
            ran: true,
            answerModified: false,
            unsupportedSegmentCount: 0,
            substantiveUnsupportedSegmentCount: 0,
            supportedSegmentCount: 1,
            nonSubstantiveSegmentCount: 0,
            segmentResults: [],
          },
          retrievalInfo: {
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
          retrievalTrace: {
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
            stages: [],
            links: [],
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

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList,
    conversationDetail,
  });

  await page.goto(`/w/${workspaceKey}/history`);

  await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /What courses are coming up next month/ }).click();

  await expect(page).toHaveURL(/itemKind=chat/);
  await expect(page.getByText("Response route")).toBeVisible();
  await expect(page.getByText("assistant").first()).toBeVisible();
  await expect(page.getByText("retrieval").first()).toBeVisible();
  await expect(page.getByText("evidence required")).toBeVisible();
  await expect(page.getByText("Retrieval was invoked for this assistant response.")).toBeVisible();
});
