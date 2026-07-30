import { expect, test, type Page } from "@playwright/test";

import {
  baseQualityStats,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

const CASE_ID = "55555555-5555-4555-8555-555555555555";

const qualityTurn = (
  assistantMessageId: string,
  question: string,
  overrides: Record<string, unknown> = {},
) => ({
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
  grounding: null,
  createdAt: nowIso,
  feedback: {
    upCount: 0,
    downCount: 1,
    latestDownUpdatedAt: nowIso,
    comments: [],
  },
  triage: {
    state: "open",
    version: 1,
    resolution: null,
    legacyReason: null,
    closedAt: null,
    updatedAt: nowIso,
  },
  verification: null,
  ...overrides,
});

const installQualityStats = async (
  page: Page,
  resolutionBreakdown: Array<Record<string, unknown>> = [],
) => {
  await page.route("**/backend/api/v1/quality/stats**", async (route) => {
    const range = new URL(route.request().url()).searchParams.get("range") === "7d"
      ? "7d"
      : "30d";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...baseQualityStats(),
        range,
        resolutionBreakdown,
      }),
    });
  });
};

test("choosing Dismissed offers optional context without opening a modal or conversation details", async ({
  page,
}) => {
  const turn = qualityTurn("message-dismiss", "Should this answer be reviewed?");
  const triageBodies: Array<Record<string, unknown>> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installQualityStats(page);
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [turn],
        total: 1,
        page: 1,
        pageSize: 25,
        totalPages: 1,
      }),
    });
  });
  await page.route("**/backend/api/v1/quality/turns/message-dismiss/triage**", async (route) => {
    triageBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: "dismissed",
        version: 2,
        resolution: null,
        legacyReason: null,
        closedAt: "2026-07-30T12:00:00.000Z",
        updatedAt: "2026-07-30T12:00:00.000Z",
      }),
    });
  });

  await page.goto(`/w/${workspaceKey}/quality`);
  await page.setViewportSize({ width: 1280, height: 360 });
  const triageTrigger = page.getByRole("button", {
    name: "Triage state: Open. Change state.",
  });
  await triageTrigger.click();
  await page.getByRole("menuitemradio", { name: "Dismissed" }).click();

  const closeReview = page.getByRole("dialog", { name: "Mark not actionable" });
  await expect(closeReview).toBeVisible();
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
  await expect(closeReview.getByRole("textbox")).toHaveCount(0);
  await expect(closeReview.getByRole("button", {
    name: "Close without reason",
  })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close details panel" })).toHaveCount(0);

  await closeReview.getByRole("button", { name: "Other…" }).click();
  await expect(closeReview.getByRole("textbox")).toBeVisible();
  const bounds = await closeReview.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(360);

  await page.keyboard.press("Escape");
  await expect(closeReview).toHaveCount(0);
  await expect(triageTrigger).toBeFocused();

  await page.setViewportSize({ width: 1280, height: 720 });
  await triageTrigger.click();
  await page.getByRole("menuitemradio", { name: "Dismissed" }).click();
  await expect(closeReview).toBeVisible();
  await expect(closeReview.getByRole("textbox")).toHaveCount(0);

  const addToEval = page.getByRole("button", { name: "Add to Eval" });
  await addToEval.focus();
  await expect(closeReview).toHaveCount(0);
  await expect(addToEval).toBeFocused();

  await triageTrigger.click();
  await page.getByRole("menuitemradio", { name: "Dismissed" }).click();
  await expect(closeReview).toBeVisible();
  await closeReview.getByRole("button", { name: "Close without reason" }).click();
  await expect(closeReview).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close details panel" })).toHaveCount(0);
  expect(triageBodies).toEqual([
    {
      state: "dismissed",
      expectedVersion: 1,
    },
  ]);
});

test("closure reviews a canonical winner before replacement and removes locally when refetch fails", async ({
  page,
}) => {
  const first = qualityTurn("message-close", "Can I return an opened item?");
  const next = qualityTurn("message-next", "Do you ship internationally?");
  const triageBodies: Array<Record<string, unknown>> = [];
  let closeAttempts = 0;
  let closed = false;
  let turnsRequests = 0;

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installQualityStats(page);
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    turnsRequests += 1;
    if (closed) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      return;
    }
    const items = [first, next];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items,
        total: items.length,
        page: 1,
        pageSize: 25,
        totalPages: 1,
      }),
    });
  });
  await page.route("**/backend/api/v1/quality/turns/message-close/triage**", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    triageBodies.push(body);
    closeAttempts += 1;
    if (closeAttempts === 1) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "QUALITY_TRIAGE_CONFLICT",
            message: "Quality triage changed",
            details: {
              current: {
                state: "resolved",
                version: 4,
                resolution: {
                  reason: "knowledge_gap",
                  note: "The help article was updated by another operator.",
                },
                legacyReason: null,
                closedAt: "2026-07-30T10:00:00.000Z",
                updatedAt: "2026-07-30T10:00:00.000Z",
              },
            },
          },
        }),
      });
      return;
    }
    closed = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state: "resolved",
        version: 5,
        resolution: { reason: "other", note: "Updated a connector mapping." },
        legacyReason: null,
        closedAt: "2026-07-30T10:05:00.000Z",
        updatedAt: "2026-07-30T10:05:00.000Z",
      }),
    });
  });

  await page.goto(`/w/${workspaceKey}/quality`);
  await page.getByRole("button", { name: "Triage state: Open. Change state." }).first().click();
  await page.getByRole("menuitemradio", { name: "Resolved" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Resolve review" })).toBeVisible();
  await dialog.getByRole("button", { name: "Other…" }).click();
  await dialog.getByRole("button", { name: "Resolve review" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Add a short note when you choose Other.",
  );

  const note = dialog.getByLabel("Short note");
  await note.fill("Updated a connector mapping.");
  await dialog.getByRole("button", { name: "Resolve review" }).click();
  await expect(dialog.getByRole("heading", {
    name: "Another operator updated this review",
  })).toBeVisible();
  const conflictPanel = dialog.getByRole("alert");
  await expect(conflictPanel.getByText("Resolved", { exact: true })).toBeVisible();
  await expect(conflictPanel.getByText("Knowledge gap", { exact: true })).toBeVisible();
  await expect(conflictPanel.getByText(
    "The help article was updated by another operator.",
  )).toBeVisible();
  await expect(conflictPanel.locator(
    'time[datetime="2026-07-30T10:00:00.000Z"]',
  )).toBeVisible();
  await expect(conflictPanel).toContainText(
    "Your decision: Other — Updated a connector mapping.",
  );
  await expect(dialog.getByRole("button", { name: "Keep current decision" })).toBeVisible();
  const replaceButton = dialog.getByRole("button", { name: "Replace current decision" });
  await expect(replaceButton).toBeDisabled();

  await dialog.getByLabel(
    "I reviewed the current decision and want to replace it.",
  ).check();
  await expect(replaceButton).toBeEnabled();
  await replaceButton.click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Review resolved." })).toBeAttached();
  await expect(page.locator('[data-quality-triage-id="message-close"]')).toHaveCount(0);
  await expect(page.locator('[data-quality-triage-id="message-next"]')).toBeFocused();
  await expect.poll(() => turnsRequests).toBeGreaterThan(1);
  expect(triageBodies).toEqual([
    {
      state: "resolved",
      expectedVersion: 1,
      resolution: { reason: "other", note: "Updated a connector mapping." },
    },
    {
      state: "resolved",
      expectedVersion: 4,
      resolution: { reason: "other", note: "Updated a connector mapping." },
    },
  ]);
});

test("a deleted linked Eval is recreated honestly through the idempotent message endpoint", async ({
  page,
}) => {
  const assistantMessageId = "message-deleted-eval";
  const requests: string[] = [];
  const turn = qualityTurn(assistantMessageId, "Can this deleted case be recovered?", {
    verification: {
      caseId: "77777777-7777-4777-8777-777777777777",
      caseStatus: "failing",
      latestRunStatus: "fail",
      latestRunAt: "2026-07-29T12:00:00.000Z",
    },
  });

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installQualityStats(page);
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [turn],
        total: 1,
        page: 1,
        pageSize: 25,
        totalPages: 1,
      }),
    });
  });
  await page.route(
    `**/backend/api/v1/evals/cases/by-source-message/${assistantMessageId}`,
    async (route) => {
      requests.push(route.request().method());
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "EVAL_CASE_NOT_FOUND", message: "Eval case not found" },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          assistantMessageId,
          case: { id: CASE_ID },
          snapshot: { id: "66666666-6666-4666-8666-666666666666" },
          created: true,
          createdBy: null,
          createdAt: nowIso,
        }),
      });
    },
  );

  await page.goto(`/w/${workspaceKey}/quality`);
  await page.getByRole("button", { name: "Open Eval, Failing" }).click();

  await expect(page).toHaveURL(`/w/${workspaceKey}/eval/${CASE_ID}`);
  expect(requests).toEqual(["GET", "PUT"]);
});

for (const scenario of [
  {
    name: "Add to Eval",
    method: "PUT",
    verification: null,
  },
  {
    name: "Open Eval, Passing",
    method: "GET",
    verification: {
      caseId: CASE_ID,
      caseStatus: "passing",
      latestRunStatus: "pass",
      latestRunAt: "2026-07-29T12:00:00.000Z",
    },
  },
] as const) {
  test(`${scenario.name} uses one message-addressed request and navigates directly`, async ({
    page,
  }) => {
    const requests: string[] = [];
    const triageRequests: unknown[] = [];
    const assistantMessageId = scenario.method === "PUT" ? "message-add-eval" : "message-open-eval";
    const turn = qualityTurn(assistantMessageId, "Was this fix verified?", {
      verification: scenario.verification,
    });

    await seedDashboardStorage(page);
    await installDashboardApiMocks(page);
    await installQualityStats(page);
    await page.route("**/backend/api/v1/quality/turns**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [turn],
          total: 1,
          page: 1,
          pageSize: 25,
          totalPages: 1,
        }),
      });
    });
    await page.route(`**/backend/api/v1/evals/cases/by-source-message/${assistantMessageId}`, async (route) => {
      requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      await route.fulfill({
        status: scenario.method === "PUT" ? 201 : 200,
        contentType: "application/json",
        body: JSON.stringify({
          assistantMessageId,
          case: { id: CASE_ID },
          snapshot: { id: "66666666-6666-4666-8666-666666666666" },
          created: scenario.method === "PUT",
          createdBy: null,
          createdAt: nowIso,
        }),
      });
    });
    await page.route(`**/backend/api/v1/quality/turns/${assistantMessageId}/triage**`, async (route) => {
      triageRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    });

    await page.goto(`/w/${workspaceKey}/quality`);
    if (scenario.verification) {
      await expect(page.getByText("Eval passed · Jul 29, 2026")).toBeVisible();
      await page.getByRole("button", { name: "Review and resolve" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Resolve review" })).toBeVisible();
      await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
      await expect(dialog.getByRole("textbox")).toHaveCount(0);
      expect(triageRequests).toEqual([]);
      await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: scenario.name }).click();

    await expect(page).toHaveURL(`/w/${workspaceKey}/eval/${CASE_ID}`);
    expect(requests).toEqual([
      `${scenario.method} /backend/api/v1/evals/cases/by-source-message/${assistantMessageId}`,
    ]);
  });
}

test("resolution filters restore from the URL and breakdown entries drill into matching closed turns", async ({
  page,
}) => {
  const requestedTurnsUrls: string[] = [];
  const from = "2026-07-01T00:00:00.000Z";
  const to = "2026-08-01T00:00:00.000Z";
  const turn = qualityTurn("message-closed", "Why was this review closed?", {
    triage: {
      state: "resolved",
      version: 3,
      resolution: { reason: "knowledge_gap", note: null },
      legacyReason: null,
      closedAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
    },
  });

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await installQualityStats(page, [
    { state: "resolved", reason: "knowledge_gap", count: 2 },
    { state: "resolved", reason: "other", count: 1 },
    { state: "dismissed", reason: "other", count: 4 },
  ]);
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    requestedTurnsUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [turn],
        total: 1,
        page: 1,
        pageSize: 25,
        totalPages: 1,
      }),
    });
  });

  await page.goto(
    `/w/${workspaceKey}/quality?triage=dismissed&resolutionReason=out_of_scope`
      + `&resolutionFrom=${encodeURIComponent(from)}&resolutionTo=${encodeURIComponent(to)}&all=true`,
  );

  await expect(page.getByRole("button", {
    name: "Remove resolution reason: Outside the agent’s scope",
  })).toBeVisible();
  await expect.poll(() => requestedTurnsUrls.at(-1)).toContain("triage=dismissed");
  await expect.poll(() => requestedTurnsUrls.at(-1)).toContain("resolutionReason=out_of_scope");
  await expect.poll(() => requestedTurnsUrls.at(-1)).toContain(
    `resolutionFrom=${encodeURIComponent(from)}`,
  );
  await expect.poll(() => requestedTurnsUrls.at(-1)).toContain(
    `resolutionTo=${encodeURIComponent(to)}`,
  );

  await page.goto(`/w/${workspaceKey}/quality`);
  const breakdown = page.getByRole("region", { name: "Closed review reasons" });
  await expect(
    breakdown.getByRole("group", { name: "Resolved" }).getByRole("button", {
      name: "1 Other",
    }),
  ).toBeVisible();
  await expect(
    breakdown.getByRole("group", { name: "Not actionable" }).getByRole("button", {
      name: "4 Other",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: /2 Knowledge gap/ }).click();

  await expect(page).toHaveURL(/triage=resolved/);
  await expect(page).toHaveURL(/resolutionReason=knowledge_gap/);
  await expect(page).toHaveURL(/all=true/);
  await expect.poll(() => requestedTurnsUrls.at(-1)).toContain("triage=resolved");
  await expect.poll(() => requestedTurnsUrls.at(-1)).toContain(
    "resolutionReason=knowledge_gap",
  );
  await expect.poll(() => requestedTurnsUrls.at(-1)).toContain(
    `resolutionFrom=${encodeURIComponent(baseQualityStats().current.from)}`,
  );
  await expect.poll(() => requestedTurnsUrls.at(-1)).toContain(
    `resolutionTo=${encodeURIComponent(baseQualityStats().current.to)}`,
  );
});
