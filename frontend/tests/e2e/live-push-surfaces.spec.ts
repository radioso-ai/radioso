import { expect, test } from "@playwright/test";

import {
  installDashboardApiMocks,
  installWorkspacePushStream,
  nowIso,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

const qualityTurn = (assistantMessageId: string, question: string) => ({
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
});

test("the quality queue picks up a triage push without a reload", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const push = await installWorkspacePushStream(page);

  let turns = [qualityTurn("first", "First question")];
  await page.route("**/backend/api/v1/quality/turns**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: turns,
        total: turns.length,
        page: 1,
        pageSize: 25,
        totalPages: 1,
      }),
    });
  });

  await page.goto(`/w/${workspaceKey}/quality?all=true`);
  await expect(page.getByRole("button", { name: "First question" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Second question" })).toHaveCount(0);

  turns = [qualityTurn("second", "Second question"), ...turns];
  push.emit({
    resourceType: "quality",
    resourceId: "message-second",
    changeKind: "quality.triage_changed",
  });

  // Reconnect backoff plus the invalidation debounce sit between the emit and the
  // refetch, and both stretch on a loaded machine.
  await expect(page.getByRole("button", { name: "Second question" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "First question" })).toBeVisible();
});

const websiteSourceId = "44444444-4444-4444-4444-444444444444";
const websiteSourceName = "anandaeurope.org";

// A `processing` job is only treated as live if it was touched recently, so the
// running case needs a real timestamp rather than the frozen fixture clock.
const crawlJob = (status: string) => ({
  id: "job-1",
  sourceId: websiteSourceId,
  requestedUrl: `https://${websiteSourceName}`,
  status,
  limit: 1000,
  documentCount: 1,
  failedPageCount: 0,
  skippedPageCount: 0,
  failures: [],
  lastError: null,
  createdAt: nowIso,
  updatedAt: status === "processing" ? new Date().toISOString() : nowIso,
  completedAt: status === "completed" ? nowIso : null,
});

test("a crawl started elsewhere wakes the sources list", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const push = await installWorkspacePushStream(page);

  await page.route("**/backend/api/v1/document/sources", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sources: [
          {
            id: websiteSourceId,
            kind: "website",
            name: websiteSourceName,
            externalId: `https://${websiteSourceName}`,
            documentCount: 1,
            lastSyncedAt: nowIso,
          },
        ],
      }),
    });
  });

  // The view opens on a settled crawl, so nothing on the page is polling for a
  // status change when the next crawl starts.
  let jobs = [crawlJob("completed")];
  await page.route("**/backend/api/v1/document/crawl/jobs**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobs, total: jobs.length, nextCursor: null, hasMore: false }),
    });
  });

  await page.goto(`/w/${workspaceKey}/knowledge?tab=sources`);
  await expect(page.getByRole("button", { name: new RegExp(websiteSourceName) }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-crawl" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause crawl" })).toHaveCount(0);

  jobs = [crawlJob("processing")];
  push.emit({
    resourceType: "crawl_job",
    resourceId: "job-1",
    changeKind: "crawl.status_changed",
  });

  // The row offers to pause only while a crawl is live, so this is the list
  // noticing a crawl it was never polling for.
  await expect(page.getByRole("button", { name: "Pause crawl" })).toBeVisible({ timeout: 15_000 });
});
