import { expect, test, type Page } from "@playwright/test";

import {
  baseQualityStats,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

const turn = (assistantMessageId: string, question: string) => ({
  assistantMessageId,
  conversationId: `conversation-${assistantMessageId}`,
  agentId: null,
  agentName: "Concierge",
  channel: "anonymous",
  question,
  answerPreview: "I could not find that in the documents.",
  skillName: "retrieval.answer",
  skillOutcome: "no_context",
  skillStatus: "completed",
  totalLatencyMs: 1200,
  createdAt: nowIso,
  feedback: { upCount: 0, downCount: 0, comments: [] },
  triage: { state: "open", reason: null, updatedAt: null },
});

const UNFILTERED_QUESTION = "Do you sell gift cards?";
const NEGATIVE_FEEDBACK_QUESTION = "Why was my order cancelled?";

const HEALTHY_QUESTION = "What are your opening hours?";

/** The four signals the queue asks for by default, in contract order. */
const ALL_SIGNALS = "negative_feedback,grounding_gaps,slow_responses,skill_failures";

/**
 * The queue table, answering by scope rather than by row count: one signal returns that
 * chip's row, the default union returns a backlog row, and a request carrying no signal
 * at all also returns a healthy answer. Every scope is therefore observable in the
 * rendered table and not only in the request log.
 */
const installQualityTurnsMock = async (page: Page, requestedUrls: string[]) => {
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    const url = new URL(route.request().url());
    requestedUrls.push(`${url.pathname}${url.search}`);
    const signal = url.searchParams.get("signal");
    const items = signal === null
      ? [turn("message-open", UNFILTERED_QUESTION), turn("message-healthy", HEALTHY_QUESTION)]
      : signal === "negative_feedback"
        ? [turn("message-negative", NEGATIVE_FEEDBACK_QUESTION)]
        : [turn("message-open", UNFILTERED_QUESTION)];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 25, totalPages: 1 }),
    });
  });
};

test("health tiles report windowed rates against the previous window", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installQualityTurnsMock(page, []);

  await page.goto(`/w/${workspaceKey}/quality`);

  // Zone 1 names its own scope, so the range control can never be read as
  // scoping the queue below it.
  await expect(page.getByRole("heading", { name: "Health · last 30 days" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Queue · all time" })).toBeVisible();

  // A volume tile carries a percent delta; rate tiles carry point deltas.
  const answers = page.getByTestId("quality-tile-answers");
  await expect(answers.getByText("600", { exact: true })).toBeVisible();
  await expect(answers.getByText("+20% vs previous 30 days")).toBeVisible();

  const grounded = page.getByTestId("quality-tile-grounded");
  await expect(grounded.getByText("87.5%", { exact: true })).toBeVisible();
  await expect(grounded.getByText("420 of 480 answer attempts")).toBeVisible();
  await expect(grounded.getByText("+2.5 pts vs previous 30 days")).toBeVisible();

  // Denominators are always printed, and a falling negative-feedback rate is an improvement.
  const negative = page.getByTestId("quality-tile-negative_feedback");
  await expect(negative.getByText("20%", { exact: true })).toBeVisible();
  await expect(negative.getByText("24 of 120 rated")).toBeVisible();
  await expect(negative.getByText("-10 pts vs previous 30 days")).toBeVisible();

  const failures = page.getByTestId("quality-tile-skill_failures");
  await expect(failures.getByText("2%", { exact: true })).toBeVisible();
  await expect(failures.getByText("-2 pts vs previous 30 days")).toBeVisible();

  // Every tile carries its own sparkline.
  await expect(page.getByTestId("quality-sparkline")).toHaveCount(4);
});

test("switching the health range refetches the rollup without touching the queue", async ({ page }) => {
  const requestLog: string[] = [];
  const turnsUrls: string[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { requestLog });
  await installQualityTurnsMock(page, turnsUrls);

  await page.goto(`/w/${workspaceKey}/quality`);
  await expect(page.getByTestId("quality-health-row")).toBeVisible();

  const turnsRequestsBefore = turnsUrls.length;
  await page.getByRole("button", { name: "7 days" }).click();

  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/quality\\?.*range=7d`));
  await expect(page.getByRole("heading", { name: "Health · last 7 days" })).toBeVisible();
  await expect(page.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "30 days" })).toHaveAttribute("aria-pressed", "false");

  await expect
    .poll(() => requestLog.filter((entry) => entry === "GET /quality/stats?range=7d"))
    .toHaveLength(1);
  expect(requestLog).toContain("GET /quality/stats?range=30d");

  // The queue is all-time: changing the health window must not refetch it.
  expect(turnsUrls).toHaveLength(turnsRequestsBefore);
});

test("the queue defaults to the answers that carry a signal and still need triage", async ({
  page,
}) => {
  const turnsUrls: string[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installQualityTurnsMock(page, turnsUrls);

  await page.goto(`/w/${workspaceKey}/quality`);
  await expect(page.getByRole("button", { name: UNFILTERED_QUESTION })).toBeVisible();

  // No chip is pressed, yet the queue is scoped: any signal, active triage only. Without
  // this the table would return every assistant turn and the chip counts would describe
  // rows nobody can see.
  await expect
    .poll(() => turnsUrls.at(-1))
    .toContain(`signal=${encodeURIComponent(ALL_SIGNALS)}`);
  await expect
    .poll(() => turnsUrls.at(-1))
    .toContain(`triage=${encodeURIComponent("open,acknowledged")}`);
  // The default is the default: it does not clutter the URL.
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/quality$`));
  await expect(page.getByRole("button", { name: "All answers" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByRole("button", { name: HEALTHY_QUESTION })).toHaveCount(0);
});

test("All answers drops the queue defaults and a chip narrows back to one signal", async ({
  page,
}) => {
  const turnsUrls: string[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installQualityTurnsMock(page, turnsUrls);

  await page.goto(`/w/${workspaceKey}/quality`);
  await expect(page.getByRole("button", { name: UNFILTERED_QUESTION })).toBeVisible();

  await page.getByRole("button", { name: "All answers" }).click();

  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/quality\\?.*all=true`));
  await expect(page.getByRole("button", { name: "All answers" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Widened: the healthy answer the default hides is now in the table.
  await expect(page.getByRole("button", { name: HEALTHY_QUESTION })).toBeVisible();
  await expect.poll(() => turnsUrls.at(-1)).not.toContain("signal=");
  await expect.poll(() => turnsUrls.at(-1)).not.toContain("triage=");

  // A chip narrows straight back to a single signal and turns the escape hatch off.
  await page.getByRole("button", { name: "7 Negative feedback" }).click();

  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/quality\\?.*signal=negative_feedback`));
  await expect(page).not.toHaveURL(/all=true/);
  await expect(page.getByRole("button", { name: "All answers" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByRole("button", { name: NEGATIVE_FEEDBACK_QUESTION })).toBeVisible();
  await expect(page.getByRole("button", { name: HEALTHY_QUESTION })).toHaveCount(0);
  await expect.poll(() => turnsUrls.at(-1)).toContain("signal=negative_feedback&");
});

test("a signal chip filters the queue by that signal", async ({ page }) => {
  const turnsUrls: string[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installQualityTurnsMock(page, turnsUrls);

  await page.goto(`/w/${workspaceKey}/quality`);
  await expect(page.getByRole("button", { name: UNFILTERED_QUESTION })).toBeVisible();

  // Chips are count-forward: the backlog count is part of the accessible name.
  const chip = page.getByRole("button", { name: "7 Negative feedback" });
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await chip.click();

  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/quality\\?.*signal=negative_feedback`));
  await expect(page.getByRole("button", { name: "7 Negative feedback" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: NEGATIVE_FEEDBACK_QUESTION })).toBeVisible();
  await expect(page.getByRole("button", { name: UNFILTERED_QUESTION })).toHaveCount(0);

  await expect
    .poll(() => turnsUrls.some((url) => url.includes("signal=negative_feedback")))
    .toBe(true);
});

test("a window below the sample floor says so instead of printing a rate", async ({ page }) => {
  const thinStats = baseQualityStats();
  thinStats.current.turnCount = 6;
  thinStats.current.grounded = { count: 3, denominator: 5, rate: 0.6 };
  thinStats.previous.grounded = { count: 2, denominator: 4, rate: 0.5 };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { qualityStats: thinStats });
  await installQualityTurnsMock(page, []);

  await page.goto(`/w/${workspaceKey}/quality`);

  const grounded = page.getByTestId("quality-tile-grounded");
  await expect(grounded.getByText("3 of 5 answer attempts — too few to rate")).toBeVisible();
  await expect(grounded.getByText("Not enough data to compare")).toBeVisible();
  // The raw count stands in for the rate — no invented percentage.
  await expect(grounded.getByText("60%")).toHaveCount(0);
});

test("a failed rollup degrades to a muted panel and leaves the queue usable", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installQualityTurnsMock(page, []);

  // Registered after the fixture's catch-all so it wins (Playwright matches
  // last-registered first) for the stats path only.
  await page.route("**/backend/api/v1/quality/stats**", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "internal_error", message: "Stats rollup unavailable" } }),
    });
  });

  await page.goto(`/w/${workspaceKey}/quality`);

  await expect(page.getByTestId("quality-health-error")).toBeVisible();
  await expect(page.getByTestId("quality-health-row")).toHaveCount(0);
  // The table still loads, and the chips fall back to "—" rather than a wrong count.
  await expect(page.getByRole("button", { name: UNFILTERED_QUESTION })).toBeVisible();
  await expect(page.getByRole("button", { name: "— Negative feedback" })).toBeVisible();
});

test("a rollup that fails after a good load drops the counts instead of showing stale ones", async ({
  page,
}) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installQualityTurnsMock(page, []);

  // Flipped once the good state is on screen, so the failure lands on a refetch and
  // not on mount. A call counter would not do: React re-runs effects on mount in
  // development, so "the second request" is not reliably the refetch.
  let rollupDown = false;
  await page.route("**/backend/api/v1/quality/stats**", async (route) => {
    if (rollupDown) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "internal_error", message: "Stats rollup unavailable" },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(baseQualityStats()),
    });
  });

  await page.goto(`/w/${workspaceKey}/quality`);
  await expect(page.getByRole("button", { name: "7 Negative feedback" })).toBeVisible();

  rollupDown = true;
  await page.getByRole("button", { name: "7 days" }).click();

  await expect(page.getByTestId("quality-health-error")).toBeVisible();
  // The counts the operator was just looking at must not survive a failed refresh.
  await expect(page.getByRole("button", { name: "7 Negative feedback" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "— Negative feedback" })).toBeVisible();
});
