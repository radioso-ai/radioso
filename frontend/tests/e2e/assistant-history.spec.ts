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
  const activityTrace = {
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
      candidateCounts: { semantic: 1, lexical: 1, merged: 1, final: 1 },
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
  };
  const turnTrace = {
    version: 1,
    spine: {
      traceId: "conversation-turn-1",
      startedAt: nowIso,
      completedAt: nowIso,
      stages: [
        { id: "gather", kind: "gather", status: "applied", outputs: { historyCount: 1 } },
        { id: "directives", kind: "directive_match", status: "skipped", outputs: { matchCount: 0 } },
        {
          id: "selection",
          kind: "skill_selection",
          status: "applied",
          outputs: { selectedSkills: ["retrieval.answer"], reason: "evidence_required" },
        },
        {
          id: "dispatch:retrieval.answer",
          kind: "skill_dispatch",
          status: "applied",
          outputs: { skillName: "retrieval.answer", outcomeStatus: "completed" },
          subTrace: { namespace: "retrieval", version: 1, payload: activityTrace },
        },
        { id: "compose", kind: "compose", status: "applied", outputs: { outcomeCount: 1 } },
      ],
    },
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
          activityTrace,
          turnTrace,
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

  await page.goto(`/w/${workspaceKey}/activity?tab=all`);

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
  // The inline Debug pane shows the textual diagnostics.
  await page.getByRole("button", { name: "Debug" }).click();
  await expect(page.getByText("Outcome summary").first()).toBeVisible();

  // The full turn flow opens full-screen from the header Flow button:
  // inputs → engine → skill path → outcome.
  await page.getByRole("button", { name: "Flow" }).click();
  await expect(page.getByText("Turn flow", { exact: true })).toBeVisible();
  await expect(page.getByText("Engine", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Retrieval", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Outcome", { exact: true }).first()).toBeVisible();
  // The retrieval capability path streams out as its own nodes.
  await expect(page.getByText("Context", { exact: true }).first()).toBeVisible();

  // Selecting the skill node shows the dispatch detail.
  await page.getByText("Retrieval", { exact: true }).first().click();
  await expect(page.getByText("Dispatch", { exact: true }).first()).toBeVisible();

  // Selecting the engine node swaps the detail pane to the selection stage.
  await page.getByText("Engine", { exact: true }).first().click();
  await expect(page.getByText("Select skill", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Close turn flow" }).click();
  await expect(page.getByText("Turn flow", { exact: true })).toHaveCount(0);
});

test("turn flow shows offered clarification decisions and candidates", async ({ page }) => {
  const conversationId = "conversation-clarification";
  const assistantMessageId = "assistant-message-clarification";
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
        preview: "Tell me about yoga",
      },
    ],
    total: 1,
    nextCursor: null,
    hasMore: false,
  };
  const turnTrace = {
    version: 1,
    spine: {
      traceId: "conversation-turn-clarification",
      startedAt: nowIso,
      completedAt: nowIso,
      stages: [
        { id: "gather", kind: "gather", status: "applied", outputs: { historyCount: 0 } },
        { id: "directives", kind: "directive_match", status: "skipped", outputs: { matchCount: 0 } },
        {
          id: "selection",
          kind: "skill_selection",
          status: "applied",
          outputs: { selectedSkills: ["retrieval.answer"], reason: "evidence_required" },
        },
        {
          id: "clarification",
          kind: "clarification",
          status: "applied",
          outputs: {
            surface: "retrieval_sense",
            decision: "offered",
            margin: 0.03,
            candidates: [
              { id: "hatha", label: "Hatha yoga", confidence: 0.73 },
              { id: "raja", label: "Raja yoga", confidence: 0.7 },
            ],
            chosenCandidateId: "hatha",
            offerOutcome: "ignored",
          },
        },
        {
          id: "dispatch:retrieval.answer",
          kind: "skill_dispatch",
          status: "applied",
          outputs: { skillName: "retrieval.answer", outcomeStatus: "completed" },
        },
        { id: "compose", kind: "compose", status: "applied", outputs: { outcomeCount: 1 } },
      ],
    },
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
        id: "user-message-clarification",
        role: "user",
        content: "Tell me about yoga",
        createdAt: nowIso,
      },
      {
        id: assistantMessageId,
        role: "assistant",
        content: "Hatha yoga emphasizes physical postures. If you meant Raja yoga, I can answer that instead.",
        createdAt: nowIso,
        citations: [],
        answerSegments: [{ text: "Hatha yoga emphasizes physical postures. If you meant Raja yoga, I can answer that instead." }],
        debug: {
          eventStatus: "success",
          recordedAt: nowIso,
          stream: false,
          citationCount: 0,
          answerOutcome: "completed",
          // A retrieval-sense ask happens post-retrieval, so a real turn carries
          // the retrieval activity trace (the Debug/Flow entry points key off it).
          activitySummary: {
            execution: {
              surface: "assistant",
              path: "assistant_retrieval",
              retrievalInvoked: true,
            },
            candidateCounts: { semantic: 2, lexical: 0, merged: 2, final: 2 },
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
            summary: {
              execution: {
                surface: "assistant",
                path: "assistant_retrieval",
                retrievalInvoked: true,
              },
              candidateCounts: { semantic: 2, lexical: 0, merged: 2, final: 2 },
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
                stageId: "answer",
                kind: "answer_outcome",
                label: "Answer outcome",
                status: "applied",
                outputs: { outcome: "clarification_asked" },
              },
            ],
            links: [{ fromStageId: "context", toStageId: "answer", kind: "sequence" }],
          },
          turnTrace,
          route: {
            generator: "assistant",
            routeType: "retrieval",
            routeReason: "clarification",
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

  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  await page.getByRole("button", { name: /Tell me about yoga/ }).click();
  await expect(page).toHaveURL(/itemKind=chat/);

  // The Flow button only renders once the Debug pane is open (same flow as the
  // turn-flow test above).
  await page.getByRole("button", { name: "Debug" }).click();
  await page.getByRole("button", { name: "Flow" }).click();

  await expect(page.getByText("Turn flow", { exact: true })).toBeVisible();
  await expect(page.getByText("Clarification", { exact: true }).first()).toBeVisible();

  // The minimap panel overlaps node hit-targets in the small test viewport, so a
  // positional click cannot land; dispatch the click on the node element itself
  // (React Flow's onNodeClick is a synthetic click listener on the node wrapper).
  await page.getByTestId("rf__node-spine:clarification").dispatchEvent("click");

  const stageDetail = page.getByTestId("turn-flow-stage-detail");
  await expect(stageDetail.getByText("retrieval_sense")).toBeVisible();
  await expect(stageDetail.getByText("offered", { exact: true })).toBeVisible();
  await expect(stageDetail.getByText("0.03")).toBeVisible();
  // The winner and alternative labels render both in the "Offer" summary (a
  // definition list) and the "Candidates" list, so scope label assertions to the
  // candidates list to avoid a strict-mode match against the Offer summary.
  const candidateList = stageDetail.getByRole("list");
  await expect(candidateList.getByText("Hatha yoga")).toBeVisible();
  await expect(stageDetail.getByText("0.73")).toBeVisible();
  await expect(candidateList.getByText("Raja yoga")).toBeVisible();
  await expect(stageDetail.getByText("0.7", { exact: true })).toBeVisible();
  await expect(stageDetail.getByText("ignored")).toBeVisible();
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

  await page.goto(`/w/${workspaceKey}/activity?tab=all&filter=chat&page=3`);
  await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();

  expect(requestLog).toContain("GET /history/chat?limit=50&offset=100");
  expect(requestLog).not.toContain("GET /history/chat?limit=50&offset=0");
  expect(requestLog).not.toContain("GET /history?limit=50&offset=100");

  requestLog.length = 0;
  await page.goto(`/w/${workspaceKey}/activity?tab=all&filter=search&page=2`);
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
