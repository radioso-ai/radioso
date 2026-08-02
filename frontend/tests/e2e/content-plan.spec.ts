import { expect, test, type Page, type Route } from "@playwright/test";

import type {
  ContentPlanProjection,
  ContentPlanProjectionState,
  ContentPlanTopicSummary,
} from "../../lib/api-content-plan";

import {
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

const TOPIC_A_ID = "a1111111-1111-4111-8111-111111111111";
const TOPIC_B_ID = "b2222222-2222-4222-8222-222222222222";
const TOPIC_MERGED_OLD_ID = "c3333333-3333-4333-8333-333333333333";
const TOPIC_MERGED_NEW_ID = "d4444444-4444-4444-8444-444444444444";
const CONVERSATION_ID = "e5555555-5555-4555-8555-555555555555";
const ASSISTANT_MESSAGE_ID = "f6666666-6666-4666-8666-666666666666";
const OBSERVATION_ID = "88888888-8888-4888-8888-888888888888";
const DOCUMENT_ID = "99999999-9999-4999-8999-999999999999";

const window30d = () => ({
  from: "2026-07-03T00:00:00.000Z",
  to: "2026-08-02T00:00:00.000Z",
});

const comparisonWindow30d = () => ({
  from: "2026-06-03T00:00:00.000Z",
  to: "2026-07-03T00:00:00.000Z",
});

const readyProjection = (): ContentPlanProjection => ({
  state: "ready" as const,
  processedThrough: nowIso,
  processingLagSeconds: 0,
  pendingEmbeddingCount: 0,
  pendingAssignmentCount: 0,
  pendingEnrichmentTopicCount: 0,
  processedCount: null,
  totalCount: null,
  embeddingSpaceFingerprint: "space-1",
  reason: null,
});

const grounded = (values: {
  grounded: number;
  degraded: number;
  no_support: number;
  not_evaluated: number;
}) => ({
  groundedAnswerCount: values.grounded,
  degradedAnswerCount: values.degraded,
  noSupportAnswerCount: values.no_support,
  notEvaluatedAnswerCount: values.not_evaluated,
  evaluatedAnswerCount: values.grounded + values.degraded + values.no_support,
  reducedOrNoSupportRate:
    values.grounded + values.degraded + values.no_support === 0
      ? null
      : (values.degraded + values.no_support)
        / (values.grounded + values.degraded + values.no_support),
  headlineState:
    values.grounded + values.degraded + values.no_support === 0
      ? ("unmeasured" as const)
      : values.grounded + values.degraded + values.no_support < 5
        ? ("insufficient_measured_turns" as const)
        : ("measured" as const),
});

const topicA = (): ContentPlanTopicSummary => ({
  id: TOPIC_A_ID,
  lifecycle: "mature" as const,
  label: "Refund policy",
  description: "How refunds work for annual plans.",
  labelState: "ready" as const,
  demand: {
    currentQuestionCount: 14,
    comparisonQuestionCount: 8,
    currentConversationCount: 11,
    comparisonConversationCount: 6,
    currentShare: 0.35,
    absoluteChange: 6,
    trend: "rising" as const,
  },
  grounding: grounded({ grounded: 2, degraded: 3, no_support: 5, not_evaluated: 4 }),
  evidence: {
    strength: "medium" as const,
    evaluatedConversationCount: 9,
    activeGapConversationCount: 5,
  },
  opportunity: {
    credible: true,
    priorityReasons: ["active_no_support", "rising_demand"],
  },
  recommendation: {
    action: "add_content" as const,
    state: "ready" as const,
    rationale: "Repeated refund-eligibility questions with no supporting document.",
    suggestedTitle: "Refund eligibility for annual plans",
    questionsToAnswer: [
      "Are annual plans refundable within 14 days?",
      "How are pro-rated refunds calculated?",
      "Which payment methods receive refunds automatically?",
    ],
    suggestedShape: "policy" as const,
    evidenceStatement: "5 no-support and 3 degraded answers across 9 conversations.",
    factsMustBeVerified: true as const,
  },
  corpusEvidence: { state: "ready" as const, relatedDocumentCount: 0, actionRuleVersion: 1 as const },
  affected: { agentCount: 1, channelCount: 2 },
  updatedAt: nowIso,
});

const topicB = (): ContentPlanTopicSummary => ({
  id: TOPIC_B_ID,
  lifecycle: "mature" as const,
  label: "Password reset",
  description: "Self-serve password reset instructions.",
  labelState: "ready" as const,
  demand: {
    currentQuestionCount: 6,
    comparisonQuestionCount: 5,
    currentConversationCount: 5,
    comparisonConversationCount: 5,
    currentShare: 0.15,
    absoluteChange: 1,
    trend: "steady" as const,
  },
  grounding: grounded({ grounded: 5, degraded: 0, no_support: 0, not_evaluated: 1 }),
  evidence: {
    strength: "low" as const,
    evaluatedConversationCount: 4,
    activeGapConversationCount: 0,
  },
  opportunity: { credible: false, priorityReasons: [] },
  recommendation: {
    action: "monitor" as const,
    state: "ready" as const,
    rationale: null,
    suggestedTitle: null,
    questionsToAnswer: [],
    suggestedShape: null,
    evidenceStatement: "All measured answers were grounded.",
    factsMustBeVerified: true as const,
  },
  corpusEvidence: { state: "ready" as const, relatedDocumentCount: 1, actionRuleVersion: 1 as const },
  affected: { agentCount: 1, channelCount: 1 },
  updatedAt: nowIso,
});

const emergingItem = () => ({
  observationId: OBSERVATION_ID,
  question: "Do you offer education discounts?",
  sourceAvailable: true,
  conversationId: CONVERSATION_ID,
  assistantMessageId: ASSISTANT_MESSAGE_ID,
  questionCount: 1,
  conversationCount: 1,
  observedAt: nowIso,
  state: "emerging" as const,
});

const opportunitiesPage = (overrides: Partial<ReturnType<typeof buildBasePage>> = {}) => ({
  ...buildBasePage(),
  ...overrides,
});

const buildBasePage = () => ({
  range: "30d" as const,
  window: window30d(),
  comparisonWindow: comparisonWindow30d(),
  asOf: nowIso,
  projection: readyProjection(),
  summary: {
    questionCount: 40,
    conversationCount: 30,
    matureTopicCount: 2,
    emergingQuestionCount: 1,
    opportunityCount: 1,
    grounding: grounded({ grounded: 8, degraded: 5, no_support: 6, not_evaluated: 5 }),
  },
  rankingVersion: 1 as const,
  recommendedTopicId: TOPIC_A_ID as string | null,
  items: [topicA(), topicB()],
  emerging: [emergingItem()],
  nextCursor: null as string | null,
});

const topicDetail = () => ({
  asOf: nowIso,
  window: window30d(),
  comparisonWindow: comparisonWindow30d(),
  projection: readyProjection(),
  canonicalTopicId: TOPIC_A_ID,
  redirectedFromTopicId: null,
  topic: topicA(),
  decision: {
    action: "add_content" as const,
    actionState: "ready" as const,
    reasons: [
      "No related workspace document was found by corpus similarity.",
      "5 no-support and 3 degraded answers across 9 conversations.",
    ],
  },
  representativeQuestions: [
    {
      observationId: OBSERVATION_ID,
      question: "Can I get a refund for my annual plan after 30 days?",
      sourceAvailable: true,
      conversationId: CONVERSATION_ID,
      userMessageId: null,
      assistantMessageId: ASSISTANT_MESSAGE_ID,
      observedAt: nowIso,
      groundingVerdict: "no_support" as const,
    },
  ],
  relatedDocuments: [],
  affectedAgents: [{ id: "agent-1", name: "Concierge", questionCount: 14 }],
  affectedChannels: [{ channel: null, questionCount: 14 }],
});

const sourceConversation = () => ({
  id: CONVERSATION_ID,
  conversationId: CONVERSATION_ID,
  workspaceId,
  agentId: null,
  sourceChannel: "website_embed",
  sourceOrigin: "https://example.test/pricing",
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
    {
      id: "77777777-7777-4777-8777-777777777777",
      role: "user",
      source: "customer",
      content: "Can I get a refund for my annual plan after 30 days?",
      createdAt: nowIso,
    },
    {
      id: ASSISTANT_MESSAGE_ID,
      role: "assistant",
      source: "ai_agent",
      content: "I could not find that in the workspace documents.",
      createdAt: nowIso,
      citations: [],
      answerSegments: [{
        text: "I could not find that in the workspace documents.",
        kind: "text",
      }],
      suggestions: [],
    },
  ],
});

const relatedDocument = () => ({
  id: DOCUMENT_ID,
  title: "Annual plan terms",
  updatedAt: nowIso,
  possibleRelevance: 0.86,
  evidence: {
    existedBeforeGap: true,
    retrievedByGapAnswers: true,
    citedByGapAnswers: false,
    changedAfterGap: false,
  },
});

const documentFixture = () => ({
  id: DOCUMENT_ID,
  title: "Annual plan terms",
  status: "processed",
  ragStatus: "processed",
  createdAt: nowIso,
  updatedAt: nowIso,
  metadata: {},
  sourceKind: "inline_text",
  sourceId: "66666666-6666-4666-8666-666666666666",
});

const mergedTopicDetail = () => ({
  ...topicDetail(),
  canonicalTopicId: TOPIC_MERGED_NEW_ID,
  redirectedFromTopicId: TOPIC_MERGED_OLD_ID,
  topic: { ...topicA(), id: TOPIC_MERGED_NEW_ID, label: "Refund policy (merged)" },
});

const installContentPlanRoutes = async (
  page: Page,
  overrides: {
    list?: (view: string, url: URL) => unknown;
    detail?: (topicId: string) => unknown | null;
    turns?: (topicId: string, url: URL) => unknown;
    requestLog?: string[];
  } = {},
) => {
  await page.route("**/backend/api/v1/quality/content-plan**", async (route) => {
    const url = new URL(route.request().url());
    overrides.requestLog?.push(`${route.request().method()} ${url.pathname}${url.search}`);

    const topicDetailMatch = url.pathname.match(
      /\/quality\/content-plan\/topics\/([0-9a-f-]{36})$/,
    );
    if (topicDetailMatch) {
      const topicId = topicDetailMatch[1];
      const detail = overrides.detail ? overrides.detail(topicId) : topicDetail();
      if (detail === null) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "NOT_FOUND", message: "topic gone" } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detail),
      });
      return;
    }

    const memberTurnsMatch = url.pathname.match(
      /\/quality\/content-plan\/topics\/([0-9a-f-]{36})\/turns$/,
    );
    if (memberTurnsMatch) {
      const topicId = memberTurnsMatch[1];
      const body = overrides.turns
        ? overrides.turns(topicId, url)
        : {
            items: [
              {
                assistantMessageId: ASSISTANT_MESSAGE_ID,
                conversationId: CONVERSATION_ID,
                agentId: null,
                agentName: "Concierge",
                channel: null,
                question: "Can I get a refund after 30 days?",
                answerPreview: "I could not find that in the documents.",
                skillName: "retrieval.answer",
                skillOutcome: "no_support",
                skillStatus: "completed",
                totalLatencyMs: 1200,
                grounding: null,
                createdAt: nowIso,
                feedback: { upCount: 0, downCount: 0, comments: [] },
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
          };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      return;
    }

    if (url.pathname.endsWith("/quality/content-plan")) {
      const view = url.searchParams.get("view") ?? "opportunities";
      const list = overrides.list ? overrides.list(view, url) : opportunitiesPage();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(list) });
      return;
    }

    await route.continue();
  });
};

test.describe("Content plan", () => {
  test("navigation lands on Content plan under Activity", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page);

    await page.goto(`/w/${workspaceKey}/knowledge`);
    const sidebar = page.locator('[data-slot="sidebar-container"]');
    await sidebar.getByRole("link", { name: "Activity" }).click();
    await sidebar.getByRole("link", { name: "Content plan" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/content-plan$`));
    await expect(page.getByRole("heading", { name: "Content plan" })).toBeVisible();
  });

  test("Recommended next card shows the server's top opportunity and its evidence", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page);

    await page.goto(`/w/${workspaceKey}/content-plan`);

    await expect(page.getByText("Jul 3, 2026 – Aug 2, 2026", { exact: false })).toBeVisible();
    await expect(page.getByText("Jun 3, 2026 – Jul 3, 2026", { exact: false })).toBeVisible();

    const recommendedCard = page.locator('section[aria-labelledby="content-plan-recommended-next"]');
    await expect(recommendedCard).toBeVisible();
    await expect(recommendedCard).toContainText("Refund policy");
    await expect(recommendedCard).toContainText("Write document");
    await expect(recommendedCard).toContainText("Are annual plans refundable within 14 days?");
    const topicViewNav = page.getByRole("navigation", { name: "Topic view" });
    await expect(topicViewNav.getByRole("link", { name: /Content opportunities/ }))
      .toHaveAttribute("aria-current", "page");
    await expect(topicViewNav.getByRole("link", { name: /All interests/ })).not
      .toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("tab")).toHaveCount(0);
    // The top-of-list row is flagged as Recommended.
    const firstTopicRow = page.locator('[data-content-plan-topic-row]').first();
    await expect(firstTopicRow).toContainText("Recommended");
    await expect(firstTopicRow).toContainText("Refund policy");
  });

  test("labels review-existing as a related-document handoff and opens the topic evidence", async ({ page }) => {
    const reviewTopic = {
      ...topicA(),
      recommendation: {
        ...topicA().recommendation,
        action: "review_existing_content" as const,
        suggestedTitle: null,
        questionsToAnswer: [],
        suggestedShape: null,
      },
      corpusEvidence: { state: "ready" as const, relatedDocumentCount: 1, actionRuleVersion: 1 as const },
    };
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page, {
      list: () => opportunitiesPage({ items: [reviewTopic], recommendedTopicId: TOPIC_A_ID }),
      detail: () => ({
        ...topicDetail(),
        topic: reviewTopic,
        decision: {
          action: "review_existing_content" as const,
          actionState: "ready" as const,
          reasons: ["A possibly relevant document exists."],
        },
        relatedDocuments: [relatedDocument()],
      }),
    });

    await page.goto(`/w/${workspaceKey}/content-plan`);
    const recommendedCard = page.locator('section[aria-labelledby="content-plan-recommended-next"]');
    await expect(recommendedCard.getByRole("button", { name: "Open related documents" })).toBeVisible();
    await expect(recommendedCard.getByRole("button", { name: "Review document" })).toHaveCount(0);
    await recommendedCard.getByRole("button", { name: "Open related documents" }).click();
    await expect(page).toHaveURL(new RegExp(`/content-plan/topics/${TOPIC_A_ID}$`));
    await expect(page.getByRole("heading", { name: "Related documents (1)" })).toBeVisible();
  });

  test("uses an explicit awaiting-label fallback for an unenriched mature topic", async ({ page }) => {
    const unlabeled = { ...topicA(), label: null, labelState: "pending" as const };
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page, {
      list: () => opportunitiesPage({ items: [unlabeled], recommendedTopicId: TOPIC_A_ID }),
    });

    await page.goto(`/w/${workspaceKey}/content-plan`);
    await expect(page.locator('section[aria-labelledby="content-plan-recommended-next"]'))
      .toContainText("Awaiting label");
    await expect(page.locator("[data-content-plan-topic-row]").first()).toContainText("Awaiting label");
  });

  test("loads later cursor pages without replacing or duplicating the first-page report", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    const requests: string[] = [];
    await installContentPlanRoutes(page, {
      requestLog: requests,
      list: (_view, url) => {
        if (url.searchParams.get("cursor") === "cursor-2") {
          return opportunitiesPage({
            summary: { ...buildBasePage().summary, questionCount: 999 },
            recommendedTopicId: TOPIC_B_ID,
            items: [
              { ...topicA(), label: "Duplicate refund policy" },
              topicB(),
            ],
            emerging: [],
            nextCursor: null,
          });
        }
        return opportunitiesPage({ items: [topicA()], nextCursor: "cursor-2" });
      },
    });

    await page.goto(`/w/${workspaceKey}/content-plan`);
    await page.getByRole("button", { name: "Load more topics" }).click();

    const rows = page.locator("[data-content-plan-topic-row]");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Refund policy" })).toHaveCount(1);
    await expect(page.getByText("Duplicate refund policy")).toHaveCount(0);
    await expect(page.getByText("Do you offer education discounts?")).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Content plan summary" }).getByText("40", { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('section[aria-labelledby="content-plan-recommended-next"]'),
    ).toContainText("Refund policy");
    await expect(page.getByRole("button", { name: "Load more topics" })).toHaveCount(0);
    expect(requests).toContain(
      `GET /backend/api/v1/quality/content-plan?view=opportunities&cursor=cursor-2`,
    );
  });

  test("restores a selected later-page topic after a detail-route remount and browser Back", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    const requests: string[] = [];
    await installContentPlanRoutes(page, {
      requestLog: requests,
      list: (_view, url) => url.searchParams.get("cursor") === "cursor-2"
        ? opportunitiesPage({ items: [topicB()], emerging: [], nextCursor: null })
        : opportunitiesPage({ items: [topicA()], nextCursor: "cursor-2" }),
      detail: (topicId) => topicId === TOPIC_B_ID
        ? {
            ...topicDetail(),
            canonicalTopicId: TOPIC_B_ID,
            topic: topicB(),
            decision: { action: "monitor" as const, actionState: "ready" as const, reasons: [] },
            representativeQuestions: [],
          }
        : topicDetail(),
    });

    await page.goto(`/w/${workspaceKey}/content-plan`);
    await page.getByRole("button", { name: "Load more topics" }).click();
    const laterTopic = page.locator("[data-content-plan-topic-row]", { hasText: "Password reset" });
    await laterTopic.click();
    await expect(page).toHaveURL(new RegExp(`/content-plan/topics/${TOPIC_B_ID}$`));

    await page.reload();
    await expect(page.getByLabel("Selected topic detail").getByRole("heading", { name: "Password reset" }))
      .toBeVisible();
    await page.goBack();

    await expect(page.locator("[data-content-plan-topic-row]")).toHaveCount(2);
    await expect(laterTopic).toBeFocused();
    await expect.poll(() => requests.filter((entry) => entry.includes("cursor=cursor-2")).length)
      .toBeGreaterThanOrEqual(2);
  });

  test("falls back to the first topic row when the saved return topic is filtered out", async ({ page }) => {
    let topicBFilteredOut = false;
    await page.setViewportSize({ width: 390, height: 844 });
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page, {
      list: () => opportunitiesPage({
        items: topicBFilteredOut ? [topicA()] : [topicA(), topicB()],
      }),
      detail: (topicId) => topicId === TOPIC_B_ID
        ? {
            ...topicDetail(),
            canonicalTopicId: TOPIC_B_ID,
            topic: topicB(),
            decision: { action: "monitor" as const, actionState: "ready" as const, reasons: [] },
            representativeQuestions: [],
          }
        : topicDetail(),
    });

    await page.goto(`/w/${workspaceKey}/content-plan`);
    const topicBRow = page.locator("[data-content-plan-topic-row]", { hasText: "Password reset" });
    await topicBRow.click();
    await expect(page).toHaveURL(new RegExp(`/content-plan/topics/${TOPIC_B_ID}$`));
    topicBFilteredOut = true;
    await page.reload();
    const detail = page.getByLabel("Selected topic detail");
    await expect(detail.getByRole("heading", { name: "Password reset" })).toBeVisible();
    await detail.getByRole("link", { name: "Back to Content plan" }).click();

    const firstRow = page.locator("[data-content-plan-topic-row]", { hasText: "Refund policy" });
    await expect(firstRow).toBeFocused();
    await expect(topicBRow).toHaveCount(0);
  });

  test("focuses the topic-list heading when no return row remains", async ({ page }) => {
    let listIsEmpty = false;
    await page.setViewportSize({ width: 390, height: 844 });
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page, {
      list: () => listIsEmpty
        ? opportunitiesPage({ items: [], recommendedTopicId: null })
        : opportunitiesPage({ items: [topicA()] }),
    });

    await page.goto(`/w/${workspaceKey}/content-plan`);
    await page.locator("[data-content-plan-topic-row]").first().click();
    await expect(page).toHaveURL(new RegExp(`/content-plan/topics/${TOPIC_A_ID}$`));
    listIsEmpty = true;
    await page.reload();
    const detail = page.getByLabel("Selected topic detail");
    await expect(detail.getByRole("heading", { name: "Refund policy" })).toBeVisible();
    await detail.getByRole("link", { name: "Back to Content plan" }).click();

    await expect(page.getByRole("heading", { name: "Ranked opportunities" })).toBeFocused();
    await expect(page.locator("[data-content-plan-topic-row]")).toHaveCount(0);
  });

  test("retargets saved return focus to the canonical topic after a merge redirect", async ({ page }) => {
    let canonicalListReady = false;
    await page.setViewportSize({ width: 390, height: 844 });
    const oldTopic = { ...topicA(), id: TOPIC_MERGED_OLD_ID, label: "Refund policy (old)" };
    const canonicalTopic = { ...topicA(), id: TOPIC_MERGED_NEW_ID, label: "Refund policy (merged)" };
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page, {
      list: () => opportunitiesPage({
        items: canonicalListReady
          ? [topicB(), canonicalTopic]
          : [topicB(), oldTopic],
        recommendedTopicId: canonicalListReady ? TOPIC_MERGED_NEW_ID : TOPIC_MERGED_OLD_ID,
      }),
      detail: (topicId) => {
        if (topicId === TOPIC_MERGED_OLD_ID) {
          canonicalListReady = true;
        }
        return topicId === TOPIC_MERGED_OLD_ID || topicId === TOPIC_MERGED_NEW_ID
          ? {
              ...mergedTopicDetail(),
              topic: canonicalTopic,
            }
          : topicDetail();
      },
    });

    await page.goto(`/w/${workspaceKey}/content-plan`);
    await page.locator("[data-content-plan-topic-row]", { hasText: "Refund policy (old)" }).click();
    await expect(page).toHaveURL(new RegExp(`/content-plan/topics/${TOPIC_MERGED_NEW_ID}$`));
    await page.reload();
    const detail = page.getByLabel("Selected topic detail");
    await expect(detail.getByRole("heading", { name: "Refund policy \(merged\)" })).toBeVisible();
    await detail.getByRole("link", { name: "Back to Content plan" }).click();

    const canonicalRow = page.locator("[data-content-plan-topic-row]", { hasText: "Refund policy (merged)" });
    await expect(canonicalRow).toBeFocused();
    await expect(page.locator("[data-content-plan-topic-row]", { hasText: "Password reset" }))
      .not.toBeFocused();
  });

  test("keeps loaded topics visible and offers a retry when a cursor page fails", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    let cursorRequests = 0;
    await page.route("**/backend/api/v1/quality/content-plan**", async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/quality/content-plan")) {
        await route.continue();
        return;
      }
      if (url.searchParams.get("cursor") === "cursor-2") {
        cursorRequests += 1;
        if (cursorRequests === 1) {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "temporary failure" } }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(opportunitiesPage({ items: [topicB()], nextCursor: null })),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(opportunitiesPage({ items: [topicA()], nextCursor: "cursor-2" })),
      });
    });

    await page.goto(`/w/${workspaceKey}/content-plan`);
    await page.getByRole("button", { name: "Load more topics" }).click();

    const paginationError = page.locator("#content-plan-pagination-error");
    await expect(paginationError).toContainText("temporary failure");
    await expect(page.getByText("Refund policy").first()).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("[data-content-plan-topic-row]")).toHaveCount(2);
    await expect(paginationError).toHaveCount(0);
  });

  test("ignores a delayed cursor response after switching topic views", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await page.route("**/backend/api/v1/quality/content-plan**", async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/quality/content-plan")) {
        await route.continue();
        return;
      }
      if (url.searchParams.get("cursor") === "cursor-2") {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(opportunitiesPage({
            items: [{ ...topicA(), id: TOPIC_MERGED_OLD_ID, label: "Stale paginated topic" }],
            nextCursor: null,
          })),
        });
        return;
      }
      if (url.searchParams.get("view") === "all_interests") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(opportunitiesPage({ items: [topicB()], nextCursor: null })),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(opportunitiesPage({ items: [topicA()], nextCursor: "cursor-2" })),
      });
    });

    await page.goto(`/w/${workspaceKey}/content-plan`);
    await page.getByRole("button", { name: "Load more topics" }).click();
    await expect(page.getByRole("button", { name: "Loading more topics…" })).toBeDisabled();
    await page.getByRole("link", { name: /All interests/ }).click();

    await expect(page.getByRole("heading", { name: "Password reset" })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByText("Stale paginated topic")).toHaveCount(0);
  });

  test("selecting a topic opens a shareable detail with a two-pane URL", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page);

    await page.goto(`/w/${workspaceKey}/content-plan`);
    const firstRow = page.locator('[data-content-plan-topic-row]').first();
    await firstRow.click();

    await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}$`));
    const detail = page.getByLabel("Selected topic detail");
    await expect(page.getByLabel("Content plan list")).toBeVisible();
    await expect(detail.getByText("Topic detail", { exact: true })).toBeVisible();
    await expect(detail.getByRole("link", { name: "Back to Content plan" })).toBeHidden();
    await expect(detail.getByRole("heading", { name: "Refund policy" })).toBeVisible();
    await expect(detail.getByRole("heading", { name: "Content brief" })).toBeVisible();
    await expect(detail.getByText("Refund eligibility for annual plans", { exact: true })).toBeVisible();
    await expect(detail.getByText("policy", { exact: true })).toBeVisible();
    await expect(detail.getByText("Repeated refund-eligibility questions with no supporting document.", { exact: true }))
      .toBeVisible();
    await expect(detail.getByLabel("Content brief").getByText(
      "5 no-support and 3 degraded answers across 9 conversations.",
      { exact: true },
    ))
      .toBeVisible();
    await expect(detail.getByRole("heading", { name: "Questions the content should answer" })).toBeVisible();
    const evidenceTop = await detail.getByRole("heading", { name: "Evidence and freshness" })
      .evaluate((element) => element.getBoundingClientRect().top);
    const briefTop = await detail.getByRole("heading", { name: "Content brief" })
      .evaluate((element) => element.getBoundingClientRect().top);
    expect(briefTop).toBeGreaterThan(evidenceTop);
  });

  test("narrow detail keeps actions reachable, announces Copy brief, and restores list focus", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    const additionalTopics = Array.from({ length: 10 }, (_, index) => ({
      ...topicB(),
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      label: `Additional topic ${index + 1}`,
    }));
    await installContentPlanRoutes(page, {
      list: () => opportunitiesPage({ items: [topicA(), ...additionalTopics] }),
    });

    await page.goto(`/w/${workspaceKey}/content-plan`);
    const list = page.getByLabel("Content plan list");
    const firstRow = page.locator("[data-content-plan-topic-row]").first();
    await firstRow.focus();
    const storedScrollTop = await list.evaluate((element) => {
      element.scrollTop = 240;
      return element.scrollTop;
    });
    expect(storedScrollTop).toBeGreaterThan(0);
    await page.keyboard.press("Enter");

    const detail = page.getByLabel("Selected topic detail");
    await expect(page.getByLabel("Content plan list")).toBeHidden();
    await expect(detail).toBeVisible();
    await expect(detail.getByRole("link", { name: "Back to Content plan" })).toBeVisible();
    await expect(detail.getByText("Topic detail", { exact: true })).toBeHidden();
    await expect(detail.getByRole("button", { name: "Write document" })).toBeVisible();
    await expect(detail.getByRole("button", { name: "View answers in Quality" })).toBeVisible();

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            document.body.dataset.copiedBrief = text;
          },
        },
      });
    });
    await detail.getByRole("button", { name: "Copy brief" }).click();
    await expect(detail.getByText("Brief copied.", { exact: true })).toBeVisible();
    await expect.poll(() => page.locator("body").getAttribute("data-copied-brief"))
      .toContain("Questions to answer:");
    await expect.poll(() => page.locator("body").getAttribute("data-copied-brief"))
      .not.toContain("Can I get a refund for my annual plan after 30 days?");

    await detail.getByRole("link", { name: "Back to Content plan" }).click();
    await expect(list).toBeVisible();
    await expect(firstRow).toBeFocused();
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(storedScrollTop);
  });

  test("tablet detail uses one readable pane with a back path", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page);

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);

    const detail = page.getByLabel("Selected topic detail");
    await expect(page.getByLabel("Content plan list")).toBeHidden();
    await expect(detail).toBeVisible();
    await expect(detail.getByRole("link", { name: "Back to Content plan" })).toBeVisible();
    await expect(detail.getByText("Topic detail", { exact: true })).toBeHidden();
    await expect(detail.getByRole("button", { name: "Write document" })).toBeVisible();
    await expect(detail.getByRole("button", { name: "View answers in Quality" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
      .toBe(true);
  });

  test("keeps primary detail actions inside a 200%-equivalent CSS viewport", async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 640,
      height: 450,
      deviceScaleFactor: 2,
      mobile: false,
      screenWidth: 1280,
      screenHeight: 900,
    });
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page);

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);
    const detail = page.getByLabel("Selected topic detail");
    for (const name of ["Write document", "View answers in Quality", "Copy brief"]) {
      const action = detail.getByRole("button", { name });
      await action.scrollIntoViewIfNeeded();
      await expect(action).toBeVisible();
      expect(await action.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth;
      })).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
      .toBe(true);
    await cdp.detach();
  });

  test("opens representative evidence and related Knowledge with return paths", async ({ page }) => {
    const document = documentFixture();
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page, {
      conversationDetails: { [CONVERSATION_ID]: sourceConversation() },
      documentList: { documents: [document], total: 1, nextCursor: null, hasMore: false },
      documentDetails: { [DOCUMENT_ID]: { ...document, content: "Annual plan refund terms." } },
    });
    await installContentPlanRoutes(page, {
      detail: () => ({
        ...topicDetail(),
        topic: {
          ...topicA(),
          recommendation: {
            ...topicA().recommendation,
            action: "review_existing_content" as const,
          },
          corpusEvidence: {
            state: "ready" as const,
            relatedDocumentCount: 1,
            actionRuleVersion: 1 as const,
          },
        },
        decision: {
          action: "review_existing_content" as const,
          actionState: "ready" as const,
          reasons: ["A possibly relevant document existed before the gap."],
        },
        relatedDocuments: [relatedDocument()],
      }),
    });

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);
    await page
      .getByLabel("Selected topic detail")
      .locator('section[aria-labelledby="content-plan-topic-representative"]')
      .getByRole("button", { name: "Open source conversation" })
      .click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByText("Can I get a refund for my annual plan after 30 days?")).toBeVisible();
    await expect(drawer.locator(`[data-message-id="${ASSISTANT_MESSAGE_ID}"]`)).toContainText(
      "I could not find that in the workspace documents.",
    );
    await drawer.getByRole("button", { name: "Close details panel" }).click();

    await page.getByRole("button", { name: "Review document" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/w/${workspaceKey}/knowledge/documents/${DOCUMENT_ID}\\?fromContentPlan=${TOPIC_A_ID}`),
    );
    await expect(page.getByRole("heading", { name: "Annual plan terms" })).toBeVisible();
    const returnLink = page.getByRole("link", { name: "Return to Content plan topic" });
    await expect(returnLink).toBeVisible();
    await returnLink.click();
    await expect(page).toHaveURL(
      new RegExp(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}$`),
    );
    await expect(page.getByLabel("Selected topic detail").getByRole("heading", { name: "Refund policy" }))
      .toBeVisible();
  });

  test("does not link a representative source that was removed", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page, {
      detail: () => ({
        ...topicDetail(),
        representativeQuestions: topicDetail().representativeQuestions.map((question) => ({
          ...question,
          sourceAvailable: false,
        })),
      }),
    });

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);
    const detail = page.getByLabel("Selected topic detail");
    await expect(detail.getByText("This message was removed from the workspace.")).toBeVisible();
    await expect(detail.getByRole("button", { name: "Open source conversation" })).toHaveCount(0);
  });

  test("Grounding composition shows the three measured verdicts and keeps not_evaluated separate", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page);

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);

    const composition = page
      .getByRole("group", { name: "Grounding composition of measured answers" })
      .first();
    await expect(composition).toBeVisible();
    await expect(composition.getByRole("img", { name: /Grounded/ })).toBeVisible();
    await expect(composition.getByRole("img", { name: /Degraded/ })).toBeVisible();
    await expect(composition.getByRole("img", { name: /No support/ })).toBeVisible();
    // not_evaluated is annotated separately, not inside the composition bar.
    await expect(page.locator('[data-not-evaluated]').first()).toContainText("not evaluated (separate)");
  });

  test("a merged topic id resolves to the canonical topic and rewrites the URL", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page, {
      detail: (topicId) => (
        topicId === TOPIC_MERGED_OLD_ID || topicId === TOPIC_MERGED_NEW_ID
          ? mergedTopicDetail()
          : topicDetail()
      ),
    });

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_MERGED_OLD_ID}`);
    await expect(page).toHaveURL(
      new RegExp(`/w/${workspaceKey}/content-plan/topics/${TOPIC_MERGED_NEW_ID}$`),
    );
    await expect(
      page.getByLabel("Selected topic detail").getByRole("heading", { name: "Refund policy (merged)" }),
    ).toBeVisible();
  });

  test("a not-found topic shows a bounded unavailable state", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page, { detail: () => null });

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);
    await expect(page.getByText("This topic isn't available anymore")).toBeVisible();
  });

  test("distinguishes a forbidden initial report and focuses its retryable alert", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await page.route("**/backend/api/v1/quality/content-plan**", async (route) => {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "FORBIDDEN", message: "forbidden" } }),
      });
    });

    await page.goto(`/w/${workspaceKey}/content-plan`);
    const heading = page.getByRole("heading", { name: "You do not have permission to view Content plan" });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(heading.locator("xpath=ancestor::*[@role='alert']")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Could not load Content plan" })).toHaveCount(0);
  });

  test("retries a transient detail error and restores the topic", async ({ page }) => {
    let allowDetailSuccess = false;
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await page.route("**/backend/api/v1/quality/content-plan**", async (route) => {
      const url = new URL(route.request().url());
      if (/\/quality\/content-plan\/topics\/[0-9a-f-]{36}$/.test(url.pathname)) {
        if (!allowDetailSuccess) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "INTERNAL", message: "temporary detail failure" } }),
          });
        } else {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(topicDetail()) });
        }
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(opportunitiesPage()) });
    });

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);
    const heading = page.getByRole("heading", { name: "Could not load this topic" });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(heading.locator("xpath=ancestor::*[@role='alert']")).toBeVisible();
    await expect(page.getByText("temporary detail failure")).toBeVisible();
    allowDetailSuccess = true;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByLabel("Selected topic detail").getByRole("heading", { name: "Refund policy" }))
      .toBeVisible();
  });

  test("Write document opens Knowledge with the topic-driven title and question outline prefilled", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page);

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);
    await page.getByRole("button", { name: "Write document" }).first().click();

    await expect(page).toHaveURL(
      new RegExp(
        `/w/${workspaceKey}/knowledge\\?draftFromContentPlan=${TOPIC_A_ID}|fromContentPlan=${TOPIC_A_ID}`,
      ),
    );
    const titleField = page.getByLabel("Title");
    await expect(titleField).toHaveValue("Refund eligibility for annual plans");
    // The outline holds the questions but not the visitor question text.
    const contentField = page.getByLabel("Content");
    await expect(contentField).toContainText("Questions to answer");
    await expect(contentField).toContainText("Are annual plans refundable within 14 days?");
    await expect(page).toHaveURL(
      new RegExp(`/w/${workspaceKey}/knowledge\\?fromContentPlan=${TOPIC_A_ID}$`),
    );
    await expect(page.getByRole("link", { name: "Return to Content plan topic" })).toBeVisible();
  });

  test("offers alternate Knowledge add flows while retaining the topic return context", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page);

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);
    const detail = page.getByLabel("Selected topic detail");
    await detail.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: "Import file" }).click();

    await expect(page.getByRole("dialog", { name: "Import Document" })).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/w/${workspaceKey}/knowledge\\?fromContentPlan=${TOPIC_A_ID}$`),
    );
    await expect(page.getByRole("link", { name: "Return to Content plan topic" })).toBeVisible();
  });

  test("does not open a draft when the topic disappeared before Knowledge verifies it", async ({ page }) => {
    let detailRequests = 0;
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page, {
      detail: () => {
        detailRequests += 1;
        return detailRequests === 1 ? topicDetail() : null;
      },
    });

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);
    await page.getByRole("button", { name: "Write document" }).first().click();

    await expect(page.getByRole("heading", { name: "This Content plan topic is no longer available" }))
      .toBeVisible();
    await expect(page.getByRole("dialog", { name: "Add Document" })).toHaveCount(0);
  });

  test("does not open a draft when the recommendation changed before Knowledge verifies it", async ({ page }) => {
    let detailRequests = 0;
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page, {
      detail: () => {
        detailRequests += 1;
        if (detailRequests === 1) return topicDetail();
        return {
          ...topicDetail(),
          topic: { ...topicA(), recommendation: topicB().recommendation },
          decision: { action: "monitor" as const, actionState: "ready" as const, reasons: [] },
        };
      },
    });

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);
    await page.getByRole("button", { name: "Write document" }).first().click();

    await expect(page.getByRole("heading", { name: "The recommendation changed" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Add Document" })).toHaveCount(0);
  });

  test("keeps a permission failure bounded instead of opening a blank draft", async ({ page }) => {
    let detailRequests = 0;
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await page.route("**/backend/api/v1/quality/content-plan**", async (route) => {
      const url = new URL(route.request().url());
      const isDetail = /\/quality\/content-plan\/topics\/[0-9a-f-]{36}$/.test(url.pathname);
      if (isDetail) {
        detailRequests += 1;
        if (detailRequests === 1) {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(topicDetail()) });
        } else {
          await route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "FORBIDDEN", message: "forbidden" } }),
          });
        }
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(opportunitiesPage()) });
    });

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);
    await page.getByRole("button", { name: "Write document" }).first().click();

    await expect(page.getByRole("heading", { name: "You do not have permission to use this content brief" }))
      .toBeVisible();
    await expect(page.getByRole("dialog", { name: "Add Document" })).toHaveCount(0);
  });

  test("retries a transient draft verification failure and only then opens the fresh brief", async ({ page }) => {
    let allowDraftSuccess = false;
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await page.route("**/backend/api/v1/quality/content-plan**", async (route) => {
      const url = new URL(route.request().url());
      const isDetail = /\/quality\/content-plan\/topics\/[0-9a-f-]{36}$/.test(url.pathname);
      if (isDetail) {
        if (page.url().includes(`/${workspaceKey}/knowledge`) && !allowDraftSuccess) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "INTERNAL", message: "temporary failure" } }),
          });
        } else {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(topicDetail()) });
        }
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(opportunitiesPage()) });
    });

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);
    await page.getByRole("button", { name: "Write document" }).first().click();

    await expect(page.getByRole("heading", { name: "Could not verify the current recommendation" }))
      .toBeVisible();
    await expect(page.getByRole("dialog", { name: "Add Document" })).toHaveCount(0);
    allowDraftSuccess = true;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("dialog", { name: "Add Document" })).toBeVisible();
    await expect(page.getByLabel("Title")).toHaveValue("Refund eligibility for annual plans");
  });

  test("View answers in Quality is topic-scoped and offers a return path", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    const contentPlanRequests: string[] = [];
    await installContentPlanRoutes(page, { requestLog: contentPlanRequests });

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);
    await page.getByRole("button", { name: "View answers in Quality" }).click();

    await expect(page).toHaveURL(
      new RegExp(`/w/${workspaceKey}/quality\\?.*contentPlanTopic=${TOPIC_A_ID}`),
    );

    await expect(
      page.locator('[data-content-plan-return]').getByRole("link", { name: /Return to Content plan topic/ }),
    ).toBeVisible();

    await page.goto(
      `/w/${workspaceKey}/quality?contentPlanTopic=${TOPIC_A_ID}&range=7d&signal=grounding_gaps&feedback=down&triage=resolved&all=true`,
    );
    await expect(page).toHaveURL(new RegExp(`contentPlanTopic=${TOPIC_A_ID}`));
    await expect(page).not.toHaveURL(/range=|signal=|feedback=|triage=|all=/);
    await expect(page.getByRole("heading", { name: "Topic answers · current 30-day window" }))
      .toBeVisible();
    await expect(page.getByText("Only answers assigned to this topic in the Content plan current window.", { exact: false }))
      .toBeVisible();
    await expect(page.getByRole("table", { name: "Current-window topic answers" })).toBeVisible();
    await expect(page.getByText("Queue · all time", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Filter", exact: true })).toHaveCount(0);
    await expect(page.getByText("All answers", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Triage state: Open. Change state." }))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "Add to Eval" })).toBeVisible();

    // The queue fetched from the content-plan member-turn endpoint, not the generic Quality endpoint.
    await expect
      .poll(() =>
        contentPlanRequests.some((entry) =>
          entry.includes(`/quality/content-plan/topics/${TOPIC_A_ID}/turns`),
        ),
      )
      .toBe(true);
  });

  test("same-shell generic-to-topic navigation suppresses generic rows while topic answers are delayed", async ({ page }) => {
    const genericQuestion = "Generic backlog question";
    const topicQuestion = "Topic A current-window question";
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page);
    await page.route("**/backend/api/v1/quality/turns**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [{
            ...topicDetail().representativeQuestions[0],
            assistantMessageId: ASSISTANT_MESSAGE_ID,
            conversationId: CONVERSATION_ID,
            agentId: null,
            agentName: "Concierge",
            channel: null,
            question: genericQuestion,
            answerPreview: "A generic answer.",
            skillName: "retrieval.answer",
            skillOutcome: "no_support",
            skillStatus: "completed",
            totalLatencyMs: 1200,
            grounding: null,
            createdAt: nowIso,
            feedback: { upCount: 0, downCount: 0, comments: [] },
            triage: { state: "open", version: 0, resolution: null, legacyReason: null, closedAt: null, updatedAt: null },
            verification: null,
          }],
          total: 1,
          page: 1,
          pageSize: 25,
          totalPages: 1,
        }),
      });
    });
    await page.route("**/backend/api/v1/quality/content-plan/topics/*/turns**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [{
            assistantMessageId: ASSISTANT_MESSAGE_ID,
            conversationId: CONVERSATION_ID,
            agentId: null,
            agentName: "Concierge",
            channel: null,
            question: topicQuestion,
            answerPreview: "A topic-scoped answer.",
            skillName: "retrieval.answer",
            skillOutcome: "no_support",
            skillStatus: "completed",
            totalLatencyMs: 1200,
            grounding: null,
            createdAt: nowIso,
            feedback: { upCount: 0, downCount: 0, comments: [] },
            triage: { state: "open", version: 0, resolution: null, legacyReason: null, closedAt: null, updatedAt: null },
            verification: null,
          }],
          total: 1,
          page: 1,
          pageSize: 25,
          totalPages: 1,
        }),
      });
    });

    await page.goto(`/w/${workspaceKey}/quality?all=true`);
    await expect(page.getByRole("button", { name: genericQuestion })).toBeVisible();
    await page.evaluate((href) => window.history.pushState(null, "", href),
      `/w/${workspaceKey}/quality?contentPlanTopic=${TOPIC_A_ID}`);

    await expect(page.locator('[data-content-plan-return]')).toHaveAttribute(
      "data-content-plan-topic-id",
      TOPIC_A_ID,
    );
    await expect(page.getByRole("button", { name: genericQuestion })).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Current-window topic answers" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: topicQuestion })).toBeVisible();
  });

  test("same-shell topic changes suppress prior rows and expose a retry when the new scope fails", async ({ page }) => {
    const topicAQuestion = "Topic A answer that must disappear";
    const topicBQuestion = "Topic B answer after retry";
    let topicBReady = false;
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page);
    await page.route("**/backend/api/v1/quality/content-plan/topics/*/turns**", async (route) => {
      const topicId = new URL(route.request().url()).pathname.split("/").at(-2);
      if (topicId === TOPIC_B_ID && !topicBReady) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "topic projection unavailable" } }),
        });
        return;
      }
      const question = topicId === TOPIC_B_ID ? topicBQuestion : topicAQuestion;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [{
            assistantMessageId: topicId === TOPIC_B_ID ? "11111111-aaaa-4111-8111-111111111111" : ASSISTANT_MESSAGE_ID,
            conversationId: CONVERSATION_ID,
            agentId: null,
            agentName: "Concierge",
            channel: null,
            question,
            answerPreview: "A topic-scoped answer.",
            skillName: "retrieval.answer",
            skillOutcome: "no_support",
            skillStatus: "completed",
            totalLatencyMs: 1200,
            grounding: null,
            createdAt: nowIso,
            feedback: { upCount: 0, downCount: 0, comments: [] },
            triage: { state: "open", version: 0, resolution: null, legacyReason: null, closedAt: null, updatedAt: null },
            verification: null,
          }],
          total: 1,
          page: 1,
          pageSize: 25,
          totalPages: 1,
        }),
      });
    });

    await page.goto(`/w/${workspaceKey}/quality?contentPlanTopic=${TOPIC_A_ID}`);
    await expect(page.getByRole("button", { name: topicAQuestion })).toBeVisible();
    await page.evaluate((href) => window.history.pushState(null, "", href),
      `/w/${workspaceKey}/quality?contentPlanTopic=${TOPIC_B_ID}`);

    await expect(page.locator('[data-content-plan-return]')).toHaveAttribute(
      "data-content-plan-topic-id",
      TOPIC_B_ID,
    );
    await expect(page.getByRole("button", { name: topicAQuestion })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Could not load this topic’s answers" })).toBeVisible();
    await expect(page.getByText("topic projection unavailable")).toBeVisible();
    topicBReady = true;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("button", { name: topicBQuestion })).toBeVisible();
    await expect(page.getByRole("button", { name: topicAQuestion })).toHaveCount(0);
  });

  test("stale workspace responses do not leak topics from a previously active workspace", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);

    // Serve a workspace-A response late, and a workspace-B response first.
    let listRequest = 0;
    await page.route("**/backend/api/v1/quality/content-plan**", async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/quality/content-plan")) {
        listRequest += 1;
        if (listRequest === 1) {
          // Pretend this is a slow response from the previously active workspace.
          await new Promise((resolve) => setTimeout(resolve, 250));
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ...opportunitiesPage(),
              items: [{ ...topicA(), id: TOPIC_MERGED_OLD_ID, label: "Stale-workspace topic" }],
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(opportunitiesPage()),
        });
        return;
      }
      await route.continue();
    });

    // Two rapid loads: the second must win.
    await page.goto(`/w/${workspaceKey}/content-plan?view=opportunities`);
    await page.goto(`/w/${workspaceKey}/content-plan?view=all_interests`);

    await expect(page.getByRole("heading", { name: "Refund policy" })).toBeVisible();
    await expect(page.getByText("Stale-workspace topic")).toHaveCount(0);
  });

  test("emerging questions stay quiet but can open their source conversation", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page, {
      conversationDetails: { [CONVERSATION_ID]: sourceConversation() },
    });
    await installContentPlanRoutes(page);

    await page.goto(`/w/${workspaceKey}/content-plan`);
    await expect(page.getByRole("heading", { name: "Emerging evidence" })).toBeVisible();
    await expect(page.getByText("Do you offer education discounts?")).toBeVisible();
    const emerging = page.locator('section[aria-labelledby="content-plan-emerging"]');
    await emerging.getByRole("button", { name: "Open source conversation" }).click();
    await expect(page.getByRole("dialog").locator(`[data-message-id="${ASSISTANT_MESSAGE_ID}"]`))
      .toBeVisible();
  });

  test("keyboard-only navigation moves through topic rows and activates the detail", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page);

    await page.goto(`/w/${workspaceKey}/content-plan`);
    const firstRow = page.locator('[data-content-plan-topic-row]').first();
    await firstRow.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}$`));
  });

  test("empty-traffic state does not claim healthy coverage", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page, {
      list: () => ({
        ...opportunitiesPage(),
        recommendedTopicId: null,
        items: [],
        emerging: [],
        summary: {
          questionCount: 0,
          conversationCount: 0,
          matureTopicCount: 0,
          emergingQuestionCount: 0,
          opportunityCount: 0,
          grounding: grounded({ grounded: 0, degraded: 0, no_support: 0, not_evaluated: 0 }),
        },
      }),
    });

    await page.goto(`/w/${workspaceKey}/content-plan`);
    await expect(page.getByText("No eligible visitor traffic yet")).toBeVisible();
  });

  test("communicates bootstrap, reprojection, delayed, budget-paused, and degraded states in text", async ({ page }) => {
    const scenarios: Array<{
      state: ContentPlanProjectionState;
      label: string;
      explanation: string;
    }> = [
      {
        state: "bootstrapping",
        label: "Bootstrapping",
        explanation: "Building the first coherent view",
      },
      {
        state: "reprojecting",
        label: "Reprojecting",
        explanation: "Rebuilding the projection after an embedding-space change",
      },
      {
        state: "delayed",
        label: "Delayed",
        explanation: "Processing is behind the newest turns",
      },
      {
        state: "budget_paused",
        label: "Paused (budget)",
        explanation: "Per-workspace fallback budget was reached",
      },
      {
        state: "degraded",
        label: "Degraded",
        explanation: "Some enrichment is unavailable",
      },
    ];
    let activeState = scenarios[0].state;
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page, {
      list: () => opportunitiesPage({
        projection: {
          ...readyProjection(),
          state: activeState,
          processingLagSeconds: 600,
          pendingEmbeddingCount: 2,
          pendingAssignmentCount: 3,
          pendingEnrichmentTopicCount: 1,
          processedCount: 12,
          totalCount: 40,
          reason: activeState === "budget_paused" ? "daily_budget_exhausted" : null,
        },
      }),
    });

    for (const [index, scenario] of scenarios.entries()) {
      activeState = scenario.state;
      if (index === 0) {
        await page.goto(`/w/${workspaceKey}/content-plan`);
      } else {
        await page.reload();
      }
      const status = page.locator('aside[role="status"]');
      await expect(status).toContainText(scenario.label);
      await expect(status).toContainText(scenario.explanation);
      await expect(status).toContainText("12 / 40 processed");
    }
  });

  test("shows projection freshness and pending work inside a narrow deep-linked detail", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page, {
      detail: () => ({
        ...topicDetail(),
        projection: {
          ...readyProjection(),
          state: "delayed" as const,
          pendingEmbeddingCount: 2,
          pendingAssignmentCount: 3,
          pendingEnrichmentTopicCount: 1,
          processedCount: 12,
          totalCount: 40,
        },
      }),
    });

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);
    const detail = page.getByLabel("Selected topic detail");
    const freshness = detail.locator('[role="status"]', { hasText: "Delayed" });
    await expect(freshness).toContainText("processed through");
    await expect(freshness).toContainText("2 awaiting embedding");
    await expect(freshness).toContainText("3 awaiting topic assignment");
    await expect(freshness).toContainText("1 topics enriching");
    await expect(freshness).toContainText("12 / 40 processed");
  });

  test("keeps a ready deterministic action while an unavailable generated brief stays explicit and uncopyable", async ({ page }) => {
    const unavailableRecommendation = {
      ...topicA().recommendation,
      state: "unavailable" as const,
      rationale: null,
      suggestedTitle: null,
      questionsToAnswer: [],
      suggestedShape: null,
      evidenceStatement: null,
    };
    const partialTopic = {
      ...topicA(),
      recommendation: unavailableRecommendation,
    };
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page, {
      list: () => opportunitiesPage({
        projection: { ...readyProjection(), state: "degraded" },
        items: [partialTopic],
      }),
      detail: () => ({
        ...topicDetail(),
        projection: { ...readyProjection(), state: "degraded" as const },
        topic: partialTopic,
        decision: {
          action: "add_content" as const,
          actionState: "ready" as const,
          reasons: [],
        },
      }),
    });

    await page.goto(`/w/${workspaceKey}/content-plan/topics/${TOPIC_A_ID}`);
    const recommendedCard = page.locator('section[aria-labelledby="content-plan-recommended-next"]');
    await expect(recommendedCard).toContainText("Brief unavailable");
    await expect(recommendedCard.getByRole("button", { name: "Write document" })).toBeVisible();
    await expect(page.locator("[data-content-plan-topic-row]").first()).toContainText("Brief unavailable");

    const detail = page.getByLabel("Selected topic detail");
    await expect(detail.getByText("Add content — action ready")).toBeVisible();
    await expect(detail.getByText("Brief unavailable.")).toBeVisible();
    await expect(detail.getByRole("button", { name: "Write document" })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Copy brief" })).toHaveCount(0);
    await expect(detail.getByRole("heading", { name: "Questions the content should answer" }))
      .toHaveCount(0);
  });

  test("unmeasured grounding uses raw counts, not a percentage headline", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installContentPlanRoutes(page, {
      list: () => ({
        ...opportunitiesPage(),
        summary: {
          questionCount: 5,
          conversationCount: 4,
          matureTopicCount: 1,
          emergingQuestionCount: 0,
          opportunityCount: 0,
          grounding: grounded({ grounded: 0, degraded: 0, no_support: 0, not_evaluated: 5 }),
        },
        items: [
          {
            ...topicA(),
            grounding: grounded({ grounded: 0, degraded: 0, no_support: 0, not_evaluated: 5 }),
            evidence: { strength: "none" as const, evaluatedConversationCount: 0, activeGapConversationCount: 0 },
          },
        ],
        recommendedTopicId: null,
      }),
    });

    await page.goto(`/w/${workspaceKey}/content-plan`);
    await expect(page.getByText(/Coverage is unmeasured/i)).toBeVisible();
    await expect(page.getByText(/Unmeasured — no grounding-evaluated answers/i).first()).toBeVisible();
  });
});
