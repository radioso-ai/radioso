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
      content: "It changed some workbench things.",
      createdAt: nowIso,
      citations: [],
      answerSegments: [{ text: "It changed some workbench things." }],
    },
  ],
};

const draftDirective = {
  name: "Use workbench release specifics",
  condition: { kind: "always" },
  action: "Answer workbench release questions with specific replay and eval case details.",
  tags: ["step:onboarding:answer_release"],
};

const replayDraftDirective = {
  ...draftDirective,
  priority: null,
  requiredCapabilities: [],
  dependsOn: [],
  excludes: [],
  routes: [],
  description: null,
  metadata: {},
};

const installCoachMocks = async (
  page: Page,
  requestBodies: unknown[],
  directivesListReady: Promise<void> = Promise.resolve(),
) => {
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/directives`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }

    await directivesListReady;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        directives: [],
        builtIns: [],
      }),
    });
  });

  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/directives/draft`, async (route) => {
    const body = route.request().postDataJSON();
    requestBodies.push({ endpoint: "draft", body });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        directive: draftDirective,
        diagnosis: "knowledge_recommended_deferred",
        rationale: "The coaching asks for specific release facts.",
      }),
    });
  });

  await page.route("**/backend/api/v1/evals/snapshots", async (route) => {
    const body = route.request().postDataJSON();
    requestBodies.push({ endpoint: "snapshot", body });
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
        originalAgentConfig: {
          name: "Marta",
          customInstruction: "",
          skillSettings: {},
          chatModelOverride: null,
          authoredDirectives: [],
        },
        sourceAgentId: defaultAgentId,
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
        originalAgentConfig: {
          name: "Marta",
          customInstruction: "",
          skillSettings: {},
          chatModelOverride: null,
          authoredDirectives: [],
        },
        sourceAgentId: defaultAgentId,
        capturedAt: nowIso,
        capturedBy: "operator",
      }),
    });
  });

  await page.route(`**/backend/api/v1/evals/cases/${evalCaseId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: evalCaseId,
        workspaceId,
        snapshotId,
        name: "Coach captured turn",
        assertions: [],
        status: "pending",
        lastRunId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        runs: [],
      }),
    });
  });

  await page.route(`**/backend/api/v1/evals/cases/${evalCaseId}/runs`, async (route) => {
    const body = route.request().postDataJSON();
    requestBodies.push({ endpoint: "replay", body });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        run: {
          id: "run-1",
          workspaceId,
          snapshotId,
          caseId: evalCaseId,
          mode: body.mode,
          overrides: body.overrides ?? {},
          resolvedConfig: { modelProvider: "openai", modelId: "gpt-5.2" },
          observedOutput: {
            retrievedChunks: [],
            answer: "Next time I'll mention replay previews and eval case promotion.",
            citations: [],
            answerSegments: [{ text: "Next time I'll mention replay previews and eval case promotion." }],
          },
          assertionVerdicts: [],
          status: "recorded",
          outcomeReason: null,
          startedAt: nowIso,
          completedAt: nowIso,
        },
        case: {
          id: evalCaseId,
          workspaceId,
          snapshotId,
          name: "Coach captured turn",
          assertions: [],
          status: "pending",
          lastRunId: "run-1",
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      }),
    });
  });
};

test("operator coaches a captured turn, previews a drafted directive, and validates it", async ({ page }) => {
  const requestBodies: unknown[] = [];
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];
  let resolveDirectivesList: () => void = () => undefined;
  const directivesListReady = new Promise<void>((resolve) => {
    resolveDirectivesList = resolve;
  });

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    conversationDetail: seededConversation,
    directiveUpdates,
  });
  await installCoachMocks(page, requestBodies, directivesListReady);

  await page.goto(`/w/${workspaceKey}/eval/${evalCaseId}`);

  await expect(page.getByRole("heading", { name: "Training" })).toBeVisible();
  await expect(page.getByText("It changed some workbench things.").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Loading directives…" })).toBeDisabled();
  resolveDirectivesList();
  await expect(page.getByRole("button", { name: "Draft directive" })).toBeEnabled();

  await page.getByLabel("Coach your AI agent on how to respond").fill("Use concrete workbench release details.");
  await page.getByRole("button", { name: "Draft directive" }).click();

  await expect(page.getByText("Use workbench release specifics")).toBeVisible();
  await expect(page.getByText("Answer workbench release questions with specific replay and eval case details.")).toBeVisible();
  await expect(page.getByText("step:onboarding:answer_release")).toBeVisible();
  await expect(page.getByText("Next time I'll mention replay previews and eval case promotion.")).toBeVisible();
  await expect(page.getByText("This looks like missing knowledge.")).toBeVisible();

  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByRole("button", { name: "Validated" })).toBeVisible();

  expect(requestBodies).toContainEqual({
    endpoint: "draft",
    body: {
      coachingText: "Use concrete workbench release details.",
      turn: {
        userMessage: "What changed in the workbench release?",
        assistantAnswer: "It changed some workbench things.",
      },
    },
  });
  expect(requestBodies).toContainEqual({
    endpoint: "replay",
    body: {
      mode: "full_assistant",
      overrides: {
        agentConfigOverride: {
          authoredDirectives: [replayDraftDirective],
        },
      },
    },
  });
  expect(directiveUpdates).toContainEqual({
    method: "POST",
    body: {
      ...draftDirective,
      metadata: {
        diagnosis: "knowledge_recommended_deferred",
        rationale: "The coaching asks for specific release facts.",
      },
    },
  });
});
