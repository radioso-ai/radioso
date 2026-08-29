import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  defaultAgentId,
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

  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Conversations" })).toBeVisible();
  expect(requestLog).toContain("GET /history?limit=50&offset=0");
  expect(requestLog).not.toContain("GET /history/chat?limit=50&offset=0");
  expect(requestLog).not.toContain("GET /history/search?limit=50&offset=0");
  await page.getByRole("button", { name: /What courses are coming up next month/ }).click();

  await expect(page).toHaveURL(/itemKind=chat/);
  await expect(
    page.locator("li").filter({ hasText: "Advanced techniques" }).getByRole("button", { name: /Open source 1/ }),
  ).toBeVisible();
  // Diagnostics (Debug/Flow) are builder tooling, reached from the reading
  // pane's quiet "Open in debug view" link rather than inline (spec 1116
  // User Story 4: the response view carries zero builder tools of its own).
  await page.getByRole("button", { name: "Open in debug view" }).click();
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

test("the All lens row shows the visitor label and location as plain text; the reading pane header carries the real, tracking-stripped link", async ({ page }) => {
  const conversationId = "conversation-legibility-selected";
  const conversation = {
    id: conversationId,
    agentId: defaultAgentId,
    agentName: "Marta",
    agentInternalName: "Website support",
    sourceChannel: "website_embed",
    sourceOrigin: "https://it.ananda.eu",
    entryPageUrl: "https://it.ananda.eu/support/getting-started?utm_source=chat",
    channelContext: null,
    anonymousSessionId: "visitor-session-1",
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    preview: "Selected agent conversation",
  };
  const conversationDetail = {
    conversationId,
    workspaceId,
    agentId: defaultAgentId,
    agentName: "Marta",
    agentInternalName: "Website support",
    sourceChannel: "website_embed",
    sourceOrigin: "https://it.ananda.eu",
    entryPageUrl: "https://it.ananda.eu/support/getting-started?utm_source=chat",
    channelContext: null,
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
      { id: "user-message-legibility", role: "user" as const, source: "customer" as const, content: "Selected agent conversation", createdAt: nowIso },
      { id: "assistant-message-legibility", role: "assistant" as const, source: "ai_agent" as const, content: "Happy to help.", createdAt: nowIso },
    ],
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyItems: {
      items: [{ kind: "chat", id: conversation.id, sortAt: nowIso, conversation }],
      total: 1,
      nextCursor: null,
      hasMore: false,
    },
    conversationDetail,
  });

  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  const row = page.getByRole("button", { name: /Selected agent conversation/ });

  await expect(row).toContainText("Anonymous");
  // The location renders as plain text inside the row — the row is itself
  // one big button (the row-select control), and an <a> nested inside a
  // <button> is invalid HTML that breaks keyboard/screen-reader activation.
  await expect(row).toContainText("it.ananda.eu/support/getting-started");
  await expect(row.getByRole("link")).toHaveCount(0);

  // The real, independently clickable, tracking-stripped link lives in the
  // reading pane header once the conversation is selected.
  await row.click();
  const response = page.getByLabel("Response", { exact: true });
  await expect(
    response.getByRole("link", { name: "https://it.ananda.eu/support/getting-started" }),
  ).toHaveAttribute("href", "https://it.ananda.eu/support/getting-started");
});

test("conversations toolbar search narrows the visible rows", async ({ page }) => {
  const matchingConversation = {
    id: "conversation-toolbar-match",
    agentId: defaultAgentId,
    agentName: "Gioia",
    agentInternalName: null,
    sourceChannel: "website_embed",
    sourceOrigin: "https://www.example.test",
    entryPageUrl: null,
    channelContext: null,
    anonymousSessionId: "visitor-toolbar-1",
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: 3,
    userMessageCount: 2,
    assistantMessageCount: 1,
    preview: "Disponibilità del libro in inglese",
  };
  const otherConversation = {
    id: "conversation-toolbar-other",
    agentId: defaultAgentId,
    agentName: "Gioia",
    agentInternalName: null,
    sourceChannel: "website_embed",
    sourceOrigin: "https://www.example.test",
    entryPageUrl: null,
    channelContext: null,
    anonymousSessionId: "visitor-toolbar-2",
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    preview: "Orari dei corsi di yoga settimanali",
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: {
      conversations: [matchingConversation, otherConversation],
      total: 2,
      nextCursor: null,
      hasMore: false,
    },
  });

  await page.goto(`/w/${workspaceKey}/activity?tab=all&filter=chat`);
  const list = page.getByRole("complementary", { name: "Conversations" });
  await expect(list.getByRole("button").filter({ hasText: "Disponibilità" })).toBeVisible();
  await expect(list.getByRole("button").filter({ hasText: "Orari dei corsi" })).toBeVisible();

  await page.getByPlaceholder("Search conversations").fill("yoga");

  await expect(list.getByRole("button").filter({ hasText: "Orari dei corsi" })).toBeVisible();
  await expect(list.getByRole("button").filter({ hasText: "Disponibilità" })).toHaveCount(0);
});

test("activity drawer continues a conversation in test chat", async ({ page }) => {
  const conversationId = "conversation-continue-1";
  const forkConversationId = "11111111-1111-4111-8111-111111111111";
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
        preview: "I want to continue this as a test",
      },
    ],
    total: 1,
    nextCursor: null,
    hasMore: false,
  };
  const conversationDetail = {
    conversationId,
    workspaceId,
    agentId: defaultAgentId,
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
        id: "user-message-continue-1",
        role: "user",
        content: "I want to continue this as a test",
        createdAt: nowIso,
      },
      {
        id: "assistant-message-continue-1",
        role: "assistant",
        content: "Original answer.",
        createdAt: nowIso,
        citations: [],
        answerSegments: [{ text: "Original answer." }],
      },
    ],
  };

  await seedDashboardStorage(page);
  const baseSettings = basePlatformSettings();
  const platformSettings = {
    ...baseSettings,
    assistant: {
      ...baseSettings.assistant,
      assistantBootstrapActive: false,
    },
  };
  await installDashboardApiMocks(page, {
    platformSettings,
    historyList,
    conversationDetail,
    forkConversationResponse: { conversationId: forkConversationId },
  });

  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  await page.getByRole("button", { name: /I want to continue this as a test/ }).click();
  // "Continue in test chat" is builder tooling, reached through the reading
  // pane's "Open in debug view" link (spec 1116 User Story 4).
  await page.getByRole("button", { name: "Open in debug view" }).click();
  await page.getByRole("button", { name: "Continue in test chat" }).click();

  await expect(page).toHaveURL(`/w/${workspaceKey}/agents/${defaultAgentId}?chatConversation=${forkConversationId}`);
  await expect(page.getByRole("heading", { name: "Chat", exact: true })).toBeVisible();
  await expect(page.getByText("Original answer.", { exact: true })).toBeVisible();
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

  // Debug/Flow are builder tooling, reached through the reading pane's "Open
  // in debug view" link; the Flow button only renders once the Debug pane is
  // open (same flow as the turn-flow test above).
  await page.getByRole("button", { name: "Open in debug view" }).click();
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

test("routine-driven turn without a retrieval leaf still exposes the debug panel", async ({ page }) => {
  const conversationId = "conversation-routine";
  const assistantMessageId = "assistant-message-routine";
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
        preview: "I want to order Black Soap Bar 2 units",
      },
    ],
    total: 1,
    nextCursor: null,
    hasMore: false,
  };
  // A routine drives the reply: the spine carries a `routine_resume` stage and a
  // dispatch with NO sub-trace, and the turn has no legacy `activityTrace`. There
  // is no retrieval leaf, so the only thing to inspect is the spine itself.
  const turnTrace = {
    version: 1,
    spine: {
      traceId: "conversation-turn-routine",
      startedAt: nowIso,
      completedAt: nowIso,
      stages: [
        { id: "gather", kind: "gather", status: "applied", outputs: { historyCount: 2 } },
        {
          id: "routine",
          kind: "routine_resume",
          status: "applied",
          outputs: { routineId: "order-flow", completed: false },
        },
        {
          id: "dispatch:routine",
          kind: "skill_dispatch",
          status: "applied",
          outputs: { skillName: "routine", outcomeStatus: "completed" },
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
        id: "user-message-routine",
        role: "user",
        content: "I want to order Black Soap Bar 2 units",
        createdAt: nowIso,
      },
      {
        id: assistantMessageId,
        role: "assistant",
        content: "Sure — I can help with 2 units of the Black Soap Bar. Would you like to place the order?",
        createdAt: nowIso,
        citations: [],
        answerSegments: [
          { text: "Sure — I can help with 2 units of the Black Soap Bar. Would you like to place the order?" },
        ],
        debug: {
          eventStatus: "success",
          recordedAt: nowIso,
          stream: false,
          citationCount: 0,
          answerOutcome: "completed",
          // No retrieval ran, so there is no activityTrace — only the spine.
          turnTrace,
          route: {
            generator: "assistant",
            routeType: "direct",
            routeReason: "routine",
            retrievalInvoked: false,
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
  await page.getByRole("button", { name: /I want to order Black Soap Bar 2 units/ }).click();
  await expect(page).toHaveURL(/itemKind=chat/);

  // The debug toggle must appear even though this turn has no retrieval leaf —
  // the spine envelope alone is inspectable.
  await page.getByRole("button", { name: "Open in debug view" }).click();
  await page.getByRole("button", { name: "Debug" }).click();
  await expect(page.getByText("Outcome summary").first()).toBeVisible();

  // The flow opens from the spine and shows the routine path.
  await page.getByRole("button", { name: "Flow" }).click();
  await expect(page.getByText("Turn flow", { exact: true })).toBeVisible();
});

test("Debug button stays available for a turn with no recorded diagnostics", async ({ page }) => {
  const conversationId = "conversation-no-debug";
  const assistantMessageId = "assistant-message-no-debug";
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
        preview: "Where is my order",
      },
    ],
    total: 1,
    nextCursor: null,
    hasMore: false,
  };
  // The assistant turn carries NO `debug` payload at all — e.g. a human-handled or
  // suspended turn whose trace wasn't recorded. The Debug button must still appear
  // (it is no longer gated on trace presence) and open a graceful empty state.
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
        id: "user-message-no-debug",
        role: "user",
        content: "Where is my order",
        createdAt: nowIso,
      },
      {
        id: assistantMessageId,
        role: "assistant",
        content: "A teammate is handling this.",
        createdAt: nowIso,
        citations: [],
        answerSegments: [{ text: "A teammate is handling this." }],
      },
    ],
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList,
    conversationDetail,
  });

  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  await page.getByRole("button", { name: /Where is my order/ }).click();
  await expect(page).toHaveURL(/itemKind=chat/);

  // The Debug button is present even though this turn recorded no trace...
  await page.getByRole("button", { name: "Open in debug view" }).click();
  await page.getByRole("button", { name: "Debug", exact: true }).click();
  // ...and the panel renders a graceful unavailable state instead of being hidden.
  await expect(page.getByText("Activity trace unavailable for this turn.")).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();

  expect(requestLog).toContain("GET /history/chat?limit=50&offset=100");
  expect(requestLog).not.toContain("GET /history/chat?limit=50&offset=0");
  expect(requestLog).not.toContain("GET /history?limit=50&offset=100");

  requestLog.length = 0;
  await page.goto(`/w/${workspaceKey}/activity?tab=all&filter=search&page=2`);
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();

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
