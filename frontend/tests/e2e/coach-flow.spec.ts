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
) => {
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
        capturedAt: nowIso,
        capturedBy: "operator",
      }),
    });
  });

  await page.route("**/backend/api/v1/evals/runs", async (route) => {
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
          caseId: null,
          mode: "full_assistant",
          overrides: { agentConfigOverride: body.agentConfigOverride },
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
        case: null,
        answer: "Next time I'll mention replay previews and eval case promotion.",
        citations: [],
        answerSegments: [{ text: "Next time I'll mention replay previews and eval case promotion." }],
        resolvedConfig: { modelProvider: "openai", modelId: "gpt-5.2" },
      }),
    });
  });
};

test("operator coaches a captured turn, previews a drafted directive, and validates it", async ({ page }) => {
  const requestBodies: unknown[] = [];
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    conversationDetail: seededConversation,
    directiveUpdates,
  });
  await installCoachMocks(page, requestBodies);

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=chat&replayConversationId=${conversationId}&replayMessageId=${assistantMessageId}`);

  await expect(page.getByRole("heading", { name: "Training" })).toBeVisible();
  await expect(page.getByText("It changed some workbench things.").first()).toBeVisible();

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
      snapshotId,
      agentConfigOverride: {
        authoredDirectives: [replayDraftDirective],
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
