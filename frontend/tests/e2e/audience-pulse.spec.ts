import { expect, test, type Page } from "@playwright/test";

import {
  accountId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

const period = { start: "2026-04-01T00:00:00.000Z", end: "2026-05-01T00:00:00.000Z" };

const conversationOne = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const conversationTwo = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const evidenceMessageOne = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const evidenceMessageTwo = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";

const completedReport = {
  period,
  generatedAt: nowIso,
  coverage: { populationSize: 240, sampleSize: 80, sampled: true },
  weeklyVolume: [
    { weekStart: "2026-04-01T00:00:00.000Z", visitorQuestionCount: 40, conversationCount: 22 },
    { weekStart: "2026-04-08T00:00:00.000Z", visitorQuestionCount: 55, conversationCount: 30 },
    { weekStart: "2026-04-15T00:00:00.000Z", visitorQuestionCount: 70, conversationCount: 35 },
    { weekStart: "2026-04-22T00:00:00.000Z", visitorQuestionCount: 75, conversationCount: 39 },
  ],
  summary: "Visitors mainly asked about refunds and shipping windows in the last 30 days.",
  themes: [
    {
      id: "theme-1",
      title: "Refund timing",
      description: "Repeat questions about how long refunds take after a return is accepted.",
      sampleCount: 12,
      distinctQuestionCount: 2,
      weeklyPulse: [
        { weekStart: "2026-04-01T00:00:00.000Z", count: 2 },
        { weekStart: "2026-04-08T00:00:00.000Z", count: 3 },
        { weekStart: "2026-04-15T00:00:00.000Z", count: 4 },
        { weekStart: "2026-04-22T00:00:00.000Z", count: 3 },
      ],
      grounding: { grounded: 2, degraded: 4, noSupport: 3, unknown: 3, contentGapEligible: 6 },
      evidence: [
        {
          reference: "ev-1",
          conversationId: conversationOne,
          messageId: evidenceMessageOne,
          question: "How long until I get my refund after returning?",
          occurrenceCount: 1,
        },
        {
          reference: "ev-2",
          conversationId: conversationTwo,
          messageId: evidenceMessageTwo,
          question: "When does a refund show up on my card?",
          occurrenceCount: 1,
        },
      ],
    },
  ],
  contentGaps: [
    { themeId: "theme-1", eligibleEvidenceCount: 6, distinctConversationCount: 4 },
  ],
  recommendations: [
    {
      id: "rec-1",
      themeId: "theme-1",
      title: "Explain refund timelines end-to-end",
      rationale: "Visitors repeatedly ask when the refund lands and whether their bank changes it.",
      questions: [
        "How long does the refund take after we approve it?",
        "How long does the bank take to post it?",
      ],
      evidenceReferences: ["ev-1", "ev-2"],
      startDraft: {
        title: "Refund timelines: after approval, at the bank, and reconciliations",
        questions: [
          "How long does the refund take after we approve it?",
          "How long does the bank take to post it?",
          "What should a customer do if it does not appear after 10 days?",
        ],
      },
    },
  ],
  caveats: [],
  unclassifiedQuestionCount: 0,
};

interface AudiencePulseMocks {
  state: {
    read: "not_generated" | "completed";
    refreshOutcome: "completed" | "busy" | "capacity" | "provider_unavailable";
    getCount: number;
    postCount: number;
  };
}

const installAudiencePulseMocks = async (
  page: Page,
  initial: Partial<AudiencePulseMocks["state"]> = {},
): Promise<AudiencePulseMocks> => {
  const mocks: AudiencePulseMocks = {
    state: {
      read: initial.read ?? "not_generated",
      refreshOutcome: initial.refreshOutcome ?? "completed",
      getCount: 0,
      postCount: 0,
    },
  };

  await page.route("**/backend/api/v1/quality/audience-pulse", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      mocks.state.getCount += 1;
      const body = mocks.state.read === "completed"
        ? { kind: "completed", report: completedReport }
        : { kind: "not_generated" };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      return;
    }
    if (method === "POST") {
      mocks.state.postCount += 1;
      if (mocks.state.refreshOutcome === "busy") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "AUDIENCE_PULSE_REFRESH_IN_PROGRESS",
              message: "Audience Pulse refresh is already in progress",
            },
          }),
        });
        return;
      }
      if (mocks.state.refreshOutcome === "capacity") {
        await route.fulfill({
          status: 429,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "AUDIENCE_PULSE_USAGE_LIMITED",
              message: "Audience Pulse refresh capacity is exhausted",
            },
          }),
        });
        return;
      }
      if (mocks.state.refreshOutcome === "provider_unavailable") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ kind: "unavailable", reason: "provider" }),
        });
        return;
      }
      // Successful completion: subsequent GETs should return the saved report.
      mocks.state.read = "completed";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ kind: "completed", report: completedReport }),
      });
      return;
    }
    await route.fallback();
  });

  return mocks;
};

test.describe("Audience Pulse dashboard", () => {
  test("initial → analyze → completed report journey renders volume, themes, and gaps", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    const mocks = await installAudiencePulseMocks(page);

    await page.goto(`/w/${workspaceKey}/quality?view=audience-pulse`);

    // Page loaded — the audience-pulse view rendered its header.
    await expect(page.getByRole("heading", { name: "Audience Pulse" })).toBeVisible();

    // Initial saved-report read (GET only), no provider call yet.
    await expect(page.getByText("No saved report yet")).toBeVisible();
    expect(mocks.state.getCount).toBeGreaterThanOrEqual(1);
    expect(mocks.state.postCount).toBe(0);

    // Explicit analyze runs the provider once and renders the completed report.
    await page.getByRole("button", { name: "Analyze last 30 days" }).first().click();
    await expect(page.getByRole("heading", { name: "Topics" })).toBeVisible();
    const topicsSection = page.locator('section[aria-labelledby="audience-pulse-topics"]');
    await expect(topicsSection.getByText("Refund timing", { exact: true })).toBeVisible();
    await expect(page.getByText("Explain refund timelines end-to-end")).toBeVisible();
    // Canonical sampling caveat rendered by the view appears exactly once — no duplicate from model caveats.
    await expect(page.getByText(/questions we read, not total demand/i)).toHaveCount(1);
    expect(mocks.state.postCount).toBe(1);
  });

  test("both Analyze controls are disabled while the first refresh is running", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installAudiencePulseMocks(page);

    let refreshStartedResolve: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      refreshStartedResolve = resolve;
    });
    let releaseRefreshResolve: (() => void) | undefined;
    const releaseRefresh = new Promise<void>((resolve) => {
      releaseRefreshResolve = resolve;
    });
    await page.route("**/backend/api/v1/quality/audience-pulse", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      refreshStartedResolve?.();
      await releaseRefresh;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ kind: "completed", report: completedReport }),
      });
    });

    await page.goto(`/w/${workspaceKey}/quality?view=audience-pulse`);
    const analyzeControls = page.getByRole("button", { name: "Analyze last 30 days" });
    await expect(analyzeControls).toHaveCount(2);
    await analyzeControls.nth(1).click();
    await refreshStarted;

    await expect(analyzeControls.nth(0)).toBeDisabled();
    await expect(analyzeControls.nth(1)).toBeDisabled();

    releaseRefreshResolve?.();
    await expect(page.getByRole("heading", { name: "Topics" })).toBeVisible();
  });

  test("refresh is disabled while running and surfaces 409 as a busy state, not a provider failure", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    const mocks = await installAudiencePulseMocks(page, { read: "completed", refreshOutcome: "busy" });

    await page.goto(`/w/${workspaceKey}/quality?view=audience-pulse`);
    const topicsSection = page.locator('section[aria-labelledby="audience-pulse-topics"]');
    await expect(topicsSection.getByText("Refund timing", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByText(/Another refresh is already running/i)).toBeVisible();
    // Old saved report is still visible after a busy response.
    await expect(topicsSection.getByText("Refund timing", { exact: true })).toBeVisible();
    // A 409 must not be presented as a generic refresh failure or capacity ceiling.
    await expect(page.getByText(/Refresh failed\./i)).toHaveCount(0);
    await expect(page.getByText(/capacity reached/i)).toHaveCount(0);
    expect(mocks.state.postCount).toBe(1);
  });

  test("Start draft opens the composer with a seed and never puts recommendation text in the URL", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installAudiencePulseMocks(page, { read: "completed" });

    await page.goto(`/w/${workspaceKey}/quality?view=audience-pulse`);
    await expect(page.getByText("Explain refund timelines end-to-end")).toBeVisible();

    const beforeUrl = page.url();
    await page.getByTestId("audience-pulse-start-draft-rec-1").click();

    // Confirm the click wrote the seed (proves openDraft ran with a valid workspaceId).
    const seedRightAfterClick = await page.evaluate(
      () => window.sessionStorage.getItem("radioso.audiencePulseDraftSeed"),
    );
    expect(seedRightAfterClick).not.toBeNull();

    // The URL never carries recommendation title or question text.
    await expect(page).toHaveURL(/\/knowledge/);
    const currentUrl = new URL(page.url());
    expect(currentUrl.search + currentUrl.pathname).not.toContain("Refund timelines");
    expect(currentUrl.search + currentUrl.pathname).not.toContain("after we approve");
    expect(beforeUrl).not.toBe(page.url());

    // The composer opens pre-populated with the recommendation seed.
    await expect(page.getByRole("dialog", { name: "Add Document" })).toBeVisible();
    const titleField = page.getByLabel("Title");
    await expect(titleField).toHaveValue("Refund timelines: after approval, at the bank, and reconciliations");
    const contentField = page.getByLabel("Content");
    await expect(contentField).toHaveValue(/How long does the refund take after we approve it\?/);

    // Seed is single-use: sessionStorage was cleared on consumption.
    const remaining = await page.evaluate(() => window.sessionStorage.getItem("radioso.audiencePulseDraftSeed"));
    expect(remaining).toBeNull();
  });

  test("a direct Audience Pulse draft handoff populates before its transient anchor is cleared", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await page.addInitScript(({ accountId, workspaceId }) => {
      window.sessionStorage.setItem(
        "radioso.audiencePulseDraftSeed",
        JSON.stringify({
          accountId,
          workspaceId,
          title: "Direct handoff title",
          questions: ["Direct handoff question?"],
          writtenAt: new Date().toISOString(),
        }),
      );
    }, { accountId, workspaceId });

    await page.goto(`/w/${workspaceKey}/knowledge?anchor=audience-pulse-draft`);

    await expect(page.getByRole("dialog", { name: "Add Document" })).toBeVisible();
    await expect(page.getByLabel("Title")).toHaveValue("Direct handoff title");
    await expect(page.getByLabel("Content")).toHaveValue("- Direct handoff question?");
    await expect.poll(() => new URL(page.url()).searchParams.get("anchor")).toBeNull();
    await expect(page.getByLabel("Title")).toHaveValue("Direct handoff title");
  });

  test("cancelled Start draft cannot reopen after navigating away from a document", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installAudiencePulseMocks(page, { read: "completed" });

    await page.goto(`/w/${workspaceKey}/quality?view=audience-pulse`);
    await page.getByTestId("audience-pulse-start-draft-rec-1").click();

    const addDocumentDialog = page.getByRole("dialog", { name: "Add Document" });
    await expect(addDocumentDialog).toBeVisible();
    await addDocumentDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(addDocumentDialog).toBeHidden();

    // Opening then leaving a document changes selectedDocumentId twice. A stale
    // seed used to reapply at this point and reopen the cancelled composer.
    await page.getByRole("button", { name: "Course Guide", exact: true }).click();
    await expect(page.getByRole("button", { name: "Back to documents" })).toBeVisible();
    await page.getByRole("button", { name: "Back to documents" }).click();
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
    await expect(addDocumentDialog).toBeHidden();
  });

  test("opening deeply buried evidence uses one bounded handoff request and keeps source IDs out of the URL", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page, {
      historyList: {
        conversations: [{
          id: conversationOne,
          agentId: null,
          agentName: null,
          sourceChannel: "website_embed",
          sourceOrigin: null,
          anonymousSessionId: null,
          createdAt: nowIso,
          updatedAt: nowIso,
          messageCount: 10_000,
          userMessageCount: 5_000,
          assistantMessageCount: 5_000,
          preview: "Open regular conversation",
        }],
        total: 1,
        nextCursor: null,
        hasMore: false,
      },
    });
    await installAudiencePulseMocks(page, { read: "completed" });

    const recentMessages = Array.from({ length: 50 }, (_, index) => ({
      id: `dddddddd-dddd-4ddd-8ddd-${String(index + 1).padStart(12, "0")}`,
      role: index % 2 === 0 ? "user" : "assistant",
      source: index % 2 === 0 ? "customer" : "ai_agent",
      content: `Recent conversation message ${index + 1}`,
      createdAt: nowIso,
      ...(index % 2 === 0 ? {} : { citations: [], answerSegments: [{ text: `Recent conversation message ${index + 1}` }] }),
    }));
    const detailFor = (messages: unknown[], hasOlderMessages: boolean, nextCursor: string | null, messageWindowOffset: number) => ({
      conversationId: conversationOne,
      workspaceId,
      agentId: null,
      sourceChannel: "website_embed",
      sourceOrigin: null,
      channelContext: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      // This conversation has far more than any practical client page cap. Its
      // audience-pulse evidence must still open without cursor-walking it.
      messageCount: 10_000,
      userMessageCount: 5_000,
      assistantMessageCount: 5_000,
      messagesTotal: 10_000,
      messageWindowOffset,
      messageWindowLimit: 50,
      hasOlderMessages,
      nextCursor,
      tailCursor: null,
      messages,
    });
    const historyCursors: Array<string | null> = [];
    const historyTailRequests: string[] = [];
    const evidenceAnchorBodies: unknown[] = [];
    await page.route(`**/backend/api/v1/history/chat/${conversationOne}**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/tail")) {
        historyTailRequests.push(url.pathname);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages: [], cursor: null }),
        });
        return;
      }
      const cursor = url.searchParams.get("cursor");
      historyCursors.push(cursor);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detailFor(recentMessages, true, "older-window", 2)),
      });
    });
    await page.route("**/backend/api/v1/quality/audience-pulse/evidence-anchor", async (route) => {
      expect(route.request().method()).toBe("POST");
      evidenceAnchorBodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId: conversationOne,
          source: {
            messageId: evidenceMessageOne,
            role: "user",
            source: "customer",
            content: "How long until I get my refund after returning?",
            createdAt: nowIso,
          },
          nextAssistant: {
            messageId: "cccccccc-cccc-4ccc-8ccc-000000000001",
            role: "assistant",
            source: "ai_agent",
            content: "Refunds usually arrive after the return is accepted.",
            createdAt: nowIso,
          },
        }),
      });
    });

    await page.goto(`/w/${workspaceKey}/quality?view=audience-pulse`);
    // Expand the theme card to reveal evidence questions.
    await page.getByRole("button", { name: "Show questions" }).first().click();
    await page.getByRole("button", { name: "How long until I get my refund after returning?" }).click();

    await expect(page).toHaveURL(/\/activity\?tab=all$/);
    const currentUrl = page.url();
    expect(currentUrl).not.toContain(conversationOne);
    expect(currentUrl).not.toContain(evidenceMessageOne);
    await expect(page.getByLabel("Conversation details")).toBeVisible();
    await expect(page.locator(`[data-message-id="${evidenceMessageOne}"]`)).toBeVisible();
    await expect(page.locator(`[data-message-id="${evidenceMessageOne}"] .ring-1`)).toHaveCount(1);
    expect(historyCursors).toEqual([null]);
    expect(evidenceAnchorBodies).toEqual([{ conversationId: conversationOne, messageId: evidenceMessageOne }]);
    // An unseeded live-tail poll returns the newest 50 messages. That would
    // dilute this deliberately bounded historical evidence window.
    await page.waitForTimeout(150);
    expect(historyTailRequests).toEqual([]);
    expect(await page.evaluate(() => window.sessionStorage.getItem("radioso.audiencePulseEvidenceHandoff"))).toBeNull();

    // The evidence handoff is one-shot in component state too. Closing the
    // drawer must not re-select and reopen the same historical conversation.
    const closeDetails = page.getByLabel("Close details panel");
    await expect(closeDetails).toHaveCount(1);
    await closeDetails.click();
    await page.waitForTimeout(150);
    await expect(page.getByLabel("Conversation details")).toBeHidden();

    // A later normal Activity selection of the same conversation must not
    // resurrect the consumed evidence handoff.
    const regularConversation = page.getByRole("button", { name: "Open regular conversation" });
    await expect(regularConversation).toHaveCount(1);
    await regularConversation.click();
    await expect(page.getByLabel("Conversation details")).toBeVisible();
    await page.waitForTimeout(150);
    expect(evidenceAnchorBodies).toHaveLength(1);
    expect(historyTailRequests).toHaveLength(1);
  });

  test("an explicit Activity selection clears a superseded evidence handoff", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);

    await page.goto(`/w/${workspaceKey}/activity?tab=all`);
    await page.evaluate(({ accountId, workspaceId, conversationId, messageId }) => {
      window.sessionStorage.setItem(
        "radioso.audiencePulseEvidenceHandoff",
        JSON.stringify({ accountId, workspaceId, conversationId, messageId, writtenAt: new Date().toISOString() }),
      );
    }, { accountId, workspaceId, conversationId: conversationOne, messageId: evidenceMessageOne });

    await page.goto(`/w/${workspaceKey}/activity?tab=all&filter=chat&itemKind=chat&itemId=${conversationOne}`);
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem("radioso.audiencePulseEvidenceHandoff")))
      .toBeNull();
  });

  test("collapsed topic card shows distinct questions and occurrence multiplier when deduplicated", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);

    const deduplicatedReport = {
      ...completedReport,
      themes: [{
        ...completedReport.themes[0],
        sampleCount: 9,
        distinctQuestionCount: 3,
        evidence: [
          { ...completedReport.themes[0].evidence[0], occurrenceCount: 3 },
          completedReport.themes[0].evidence[1],
        ],
      }],
    };

    await page.route("**/backend/api/v1/quality/audience-pulse", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "completed", report: deduplicatedReport }) });
        return;
      }
      await route.fallback();
    });

    await page.goto(`/w/${workspaceKey}/quality?view=audience-pulse`);

    // Collapsed card shows both distinct question count and raw occurrence total.
    await expect(page.getByText(/3 questions · asked 9×/)).toBeVisible();

    // Expanding reveals per-evidence occurrence count.
    await page.getByRole("button", { name: "Show questions" }).first().click();
    await expect(page.getByText(/asked 3×/)).toBeVisible();
  });

  test("ungrouped majority notice appears when most questions were not grouped into a topic", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);

    const highUnclassifiedReport = {
      ...completedReport,
      unclassifiedQuestionCount: 50, // 50 > 80 / 2 = 40
    };

    await page.route("**/backend/api/v1/quality/audience-pulse", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "completed", report: highUnclassifiedReport }) });
        return;
      }
      await route.fallback();
    });

    await page.goto(`/w/${workspaceKey}/quality?view=audience-pulse`);

    await expect(page.getByText(/Most questions weren/)).toBeVisible();
    await expect(page.getByText(/50 of 80/)).toBeVisible();
  });

  test("expanding a topic whose grounding is entirely unknown does not render the grounding-summary strip", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);

    const unknownGroundingReport = {
      ...completedReport,
      themes: [{
        ...completedReport.themes[0],
        grounding: { grounded: 0, degraded: 0, noSupport: 0, unknown: 12, contentGapEligible: 0 },
      }],
    };

    await page.route("**/backend/api/v1/quality/audience-pulse", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "completed", report: unknownGroundingReport }) });
        return;
      }
      await route.fallback();
    });

    await page.goto(`/w/${workspaceKey}/quality?view=audience-pulse`);
    await page.getByRole("button", { name: "Show questions" }).first().click();
    await expect(page.getByLabel("Grounding summary")).toHaveCount(0);
  });

  test("a seed keyed to a different workspace is discarded and never leaks into the composer", async ({ page }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);

    await page.goto(`/w/${workspaceKey}/knowledge`);
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();

    // Plant a mismatched seed and then navigate back to Documents with the
    // handoff anchor. The consume path must clear it and not open the composer.
    await page.evaluate(({ accountId, wrongWorkspaceId }) => {
      window.sessionStorage.setItem(
        "radioso.audiencePulseDraftSeed",
        JSON.stringify({
          accountId,
          workspaceId: wrongWorkspaceId,
          title: "Should not appear",
          questions: ["Should not appear"],
          writtenAt: new Date().toISOString(),
        }),
      );
    }, { accountId, wrongWorkspaceId: "different-workspace" });

    await page.goto(`/w/${workspaceKey}/knowledge?anchor=audience-pulse-draft`);
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();

    // The seed was cleared by the mismatch guard and never appears in the UI.
    const remaining = await page.evaluate(() => window.sessionStorage.getItem("radioso.audiencePulseDraftSeed"));
    expect(remaining).toBeNull();
    await expect(page.getByText("Should not appear")).toHaveCount(0);
  });
});
