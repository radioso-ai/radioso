import { expect, test, type Page } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

const conversationId = "11111111-1111-4111-8111-111111111111";
const userMessageId = "22222222-2222-4222-8222-222222222222";
const assistantMessageId = "33333333-3333-4333-8333-333333333333";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const evalCaseId = "55555555-5555-4555-8555-555555555555";

const seededConversation = {
  id: conversationId,
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
      id: userMessageId,
      role: "user",
      content: "What changed in the workbench release?",
      createdAt: nowIso,
    },
    {
      id: assistantMessageId,
      role: "assistant",
      content: "Original answer from the saved conversation.",
      createdAt: nowIso,
      citations: [],
      answerSegments: [{ text: "Original answer from the saved conversation." }],
    },
  ],
};

const installWorkbenchMocks = async (
  page: Page,
  requestBodies: unknown[],
  options: {
    cases?: unknown[]
    caseDetail?: unknown
  } = {},
) => {
  await page.route("**/backend/api/v1/assistant/chat", async (route) => {
    const body = route.request().postDataJSON() as { message?: string; startConversation?: boolean };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversationId,
        assistantMessageId,
        answer: body.startConversation ? "Hello, how can I help?" : `Chat answer: ${body.message}`,
        citations: [],
        answerSegments: [{ text: body.startConversation ? "Hello, how can I help?" : `Chat answer: ${body.message}` }],
        debug: {
          activityTrace: {
            traceId: "chat-trace",
            startedAt: nowIso,
            stages: [],
            links: [],
          },
        },
      }),
    });
  });

  await page.route("**/api/chat/stream", async (route) => {
    const body = route.request().postDataJSON() as { query?: string; message?: string; agentId?: string };
    const message = body.query ?? body.message ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversationId,
        assistantMessageId,
        agentId: body.agentId,
        answer: `Chat answer: ${message}`,
        citations: [],
        answerSegments: [{ text: `Chat answer: ${message}` }],
        debug: {
          activityTrace: {
            traceId: "chat-trace",
            startedAt: nowIso,
            stages: [],
            links: [],
          },
        },
      }),
    });
  });

  await page.route("**/backend/api/v1/evals/snapshots", async (route) => {
    requestBodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: snapshotId,
        workspaceId,
        sourceConversationId: conversationId,
        sourceMessageId: assistantMessageId,
        fidelity: "full",
        messages: seededConversation.messages,
        originalInstructionBlock: null,
        originalModelId: null,
        originalRetrievalSettings: null,
        originalRetrievalResult: null,
        originalAgent: null,
        capturedAt: nowIso,
        capturedBy: "operator",
      }),
    });
  });

  await page.route(`**/backend/api/v1/evals/snapshots/${snapshotId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: snapshotId,
        workspaceId,
        sourceConversationId: conversationId,
        sourceMessageId: assistantMessageId,
        fidelity: "full",
        messages: seededConversation.messages,
        originalInstructionBlock: null,
        originalModelId: null,
        originalRetrievalSettings: null,
        originalRetrievalResult: null,
        originalAgent: null,
        capturedAt: nowIso,
        capturedBy: "operator",
      }),
    });
  });

  await page.route("**/backend/api/v1/evals/runs", async (route) => {
    const body = route.request().postDataJSON();
    requestBodies.push(body);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        run: {
          id: "run-1",
          workspaceId,
          snapshotId,
          caseId: null,
          mode: "full_assistant",
          overrides: { agentConfigOverride: body.agentConfigOverride },
          resolvedConfig: { modelProvider: "openai", modelId: "gpt-5.2" },
          observedOutput: {
            retrievedChunks: [],
            answer: "Replay answer with the override.",
            citations: [],
            answerSegments: [{ text: "Replay answer with the override." }],
          },
          assertionVerdicts: [],
          status: "recorded",
          outcomeReason: null,
          startedAt: nowIso,
          completedAt: nowIso,
        },
        case: null,
        answer: "Replay answer with the override.",
        citations: [],
        answerSegments: [{ text: "Replay answer with the override." }],
        turnTrace: {
          version: 1,
          spine: {
            traceId: "turn-trace-1",
            startedAt: nowIso,
            completedAt: nowIso,
            stages: [
              { id: "gather", kind: "gather", status: "applied", outputs: { historyCount: 1 } },
              { id: "compose", kind: "compose", status: "applied", outputs: { outcomeCount: 1 } },
            ],
          },
        },
        resolvedConfig: { modelProvider: "openai", modelId: "gpt-5.2", retrievedChunks: [] },
      }),
    });
  });

  await page.route("**/backend/api/v1/evals/cases", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ cases: options.cases ?? [] }),
      });
      return;
    }

    const body = route.request().postDataJSON();
    requestBodies.push(body);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: evalCaseId,
        workspaceId,
        snapshotId: body.snapshotId,
        name: body.name,
        assertions: body.assertions ?? [],
        status: "pending",
        lastRunId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
    });
  });

  await page.route(`**/backend/api/v1/evals/cases/${evalCaseId}/runs`, async (route) => {
    const body = route.request().postDataJSON();
    requestBodies.push(body);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        run: {
          id: "case-run-1",
          workspaceId,
          snapshotId,
          caseId: evalCaseId,
          mode: body.mode,
          overrides: body.overrides ?? {},
          resolvedConfig: { modelProvider: "openai", modelId: "gpt-5.2" },
          observedOutput: {
            retrievedChunks: [],
            answer: "Replay answer with the override.",
            citations: [],
            answerSegments: [{ text: "Replay answer with the override." }],
          },
          assertionVerdicts: [],
          status: "pending",
          outcomeReason: null,
          startedAt: nowIso,
          completedAt: nowIso,
        },
        case: {
          ...(options.caseDetail && typeof options.caseDetail === "object"
            ? options.caseDetail
            : {
                id: evalCaseId,
                workspaceId,
                snapshotId,
                name: "Workbench replay regression",
                assertions: [],
                status: "recorded",
                lastRunId: "case-run-1",
                createdAt: nowIso,
                updatedAt: nowIso,
              }),
        },
      }),
    });
  });

  await page.route(`**/backend/api/v1/evals/cases/${evalCaseId}`, async (route) => {
    if (options.caseDetail) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(options.caseDetail),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: evalCaseId,
        workspaceId,
        snapshotId,
        name: "Workbench replay regression",
        assertions: [{ type: "llm_judge", expectedAnswer: "Replay answer with the override." }],
        status: "pending",
        lastRunId: "case-run-1",
        createdAt: nowIso,
        updatedAt: nowIso,
        runs: [
          {
            id: "case-run-1",
            workspaceId,
            snapshotId,
            caseId: evalCaseId,
            mode: "full_assistant",
            overrides: { agentConfigOverride: { customInstruction: "Prefer implementation details." } },
            resolvedConfig: { modelProvider: "openai", modelId: "gpt-5.2" },
            observedOutput: {
              retrievedChunks: [],
              answer: "Replay answer with the override.",
              citations: [],
              answerSegments: [{ text: "Replay answer with the override." }],
            },
            assertionVerdicts: [],
            status: "recorded",
            outcomeReason: null,
            startedAt: nowIso,
            completedAt: nowIso,
          },
        ],
      }),
    });
  });

  // Registered last so this exact path wins over the broad eval-cases route.
  await page.route(
    `**/backend/api/v1/evals/cases/by-source-message/${assistantMessageId}`,
    async (route) => {
      requestBodies.push({
        sourceMessageId: assistantMessageId,
        method: route.request().method(),
      });
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          assistantMessageId,
          case: { id: evalCaseId },
          snapshot: { id: snapshotId },
          created: true,
          createdBy: null,
          createdAt: nowIso,
        }),
      });
    },
  );
};

const installQualityMocks = async (page: Page) => {
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            assistantMessageId,
            conversationId,
            agentId: defaultAgentId,
            agentName: "Marta",
            channel: "authenticated_chat",
            question: "What changed in the workbench release?",
            answerPreview: "Original answer from the saved conversation.",
            skillName: "retrieval.answer",
            skillOutcome: "degraded",
            skillStatus: "completed",
            totalLatencyMs: 3200,
            createdAt: nowIso,
            feedback: {
              upCount: 0,
              downCount: 1,
              latestDownUpdatedAt: nowIso,
              comments: [],
            },
            triage: {
              state: "open",
              version: 0,
              resolution: null,
              legacyReason: null,
              closedAt: null,
              updatedAt: null,
            },
            verification: null,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
        totalPages: 1,
      }),
    });
  });
};

test("no-override chat tab sends through the normal chat flow", async ({ page }) => {
  const requestBodies: unknown[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installWorkbenchMocks(page, requestBodies);

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=chat`);
  await page.getByPlaceholder("Ask a question...").fill("Explain workbench replay");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText("Chat answer: Explain workbench replay")).toBeVisible();
  expect(requestBodies.some((body) => JSON.stringify(body).includes("agentConfigOverride"))).toBe(false);
});

test("quality turn adds and opens an eval case with one request", async ({ page }) => {
  const requestBodies: unknown[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { conversationDetail: seededConversation });
  await installWorkbenchMocks(page, requestBodies);
  await installQualityMocks(page);

  await page.goto(`/w/${workspaceKey}/quality`);
  await page.getByRole("button", { name: "Add to Eval" }).click();

  await expect(page).toHaveURL(`/w/${workspaceKey}/eval/${evalCaseId}`);
  await expect(page.getByRole("heading", { name: "Workbench replay regression" })).toBeVisible();
  expect(requestBodies).toEqual([{
    sourceMessageId: assistantMessageId,
    method: "PUT",
  }]);
});

test("event retrieval eval case shows dated assertions and records a run", async ({ page }) => {
  const requestBodies: unknown[] = [];
  const eventCase = {
    id: evalCaseId,
    workspaceId,
    snapshotId,
    name: "Anchorless next events listing",
    assertions: [
      {
        type: "retrieval_document_order",
        documentIds: [
          "11111111-1111-4111-8111-111111111102",
          "11111111-1111-4111-8111-111111111101",
          "11111111-1111-4111-8111-111111111103",
        ],
      },
      {
        type: "retrieval_chunk_metadata",
        documentId: "11111111-1111-4111-8111-111111111101",
        metadata: { dateFrom: "2026-08-10", dateTo: "2026-08-10" },
      },
    ],
    status: "recorded",
    lastRunId: "event-run-1",
    createdAt: nowIso,
    updatedAt: nowIso,
    runs: [
      {
        id: "event-run-1",
        workspaceId,
        snapshotId,
        caseId: evalCaseId,
        mode: "full_assistant",
        overrides: {},
        resolvedConfig: { modelProvider: "openai", modelId: "gpt-5.2" },
        observedOutput: {
          retrievedChunks: [
            {
              documentId: "11111111-1111-4111-8111-111111111102",
              chunkId: "chunk-102",
              title: "Morning Retreat",
              content: "Morning Retreat happens on July 5, 2026.",
              metadata: { dateFrom: "2026-07-05", dateTo: "2026-07-05" },
            },
            {
              documentId: "11111111-1111-4111-8111-111111111101",
              chunkId: "chunk-101",
              title: "Summer Workshop",
              content: "Summer Workshop happens on August 10, 2026.",
              metadata: { dateFrom: "2026-08-10", dateTo: "2026-08-10" },
            },
          ],
          answer: "Morning Retreat is first, then Summer Workshop.",
          citations: [],
          answerSegments: [{ text: "Morning Retreat is first, then Summer Workshop." }],
        },
        assertionVerdicts: [
          {
            assertion: {
              type: "retrieval_document_order",
              documentIds: [
                "11111111-1111-4111-8111-111111111102",
                "11111111-1111-4111-8111-111111111101",
                "11111111-1111-4111-8111-111111111103",
              ],
            },
            passed: true,
            reason: "Retrieved evidence matched the expected event order.",
          },
          {
            assertion: {
              type: "retrieval_chunk_metadata",
              documentId: "11111111-1111-4111-8111-111111111101",
              metadata: { dateFrom: "2026-08-10", dateTo: "2026-08-10" },
            },
            passed: true,
            reason: "Summer Workshop chunk included the normalized date metadata.",
          },
        ],
        status: "passed",
        outcomeReason: null,
        startedAt: nowIso,
        completedAt: nowIso,
      },
    ],
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installWorkbenchMocks(page, requestBodies, {
    cases: [eventCase],
    caseDetail: eventCase,
  });

  await page.goto(`/w/${workspaceKey}/eval/${evalCaseId}`);

  await expect(page.getByRole("heading", { name: "Anchorless next events listing" })).toBeVisible();
  await expect(page.getByText("Documents should appear in order")).toBeVisible();
  await expect(page.getByText("Retrieved chunk should have metadata")).toBeVisible();
  await expect(page.getByText("Retrieved evidence matched the expected event order.")).toBeVisible();

  await page.getByRole("button", { name: "Run case" }).click();
  await expect.poll(() =>
    requestBodies.some((body) =>
      Boolean(body) &&
      typeof body === "object" &&
      "mode" in body &&
      (body as { mode?: unknown }).mode === "full_assistant",
    ),
  ).toBe(true);
});
