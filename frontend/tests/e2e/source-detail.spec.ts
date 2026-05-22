import { expect, test } from "@playwright/test";

import {
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

const websiteSourceId = "44444444-4444-4444-4444-444444444444";
const websiteSourceName = "anandaeurope.org";
const sourceDocument = {
  id: "doc-1",
  title: "Course Guide",
  status: "ready",
  ragStatus: "processed",
  createdAt: nowIso,
  updatedAt: nowIso,
  metadata: { sourceUrl: "https://anandaeurope.org/course-guide" },
  sourceKind: "inline_text" as const,
  sourceId: websiteSourceId,
  source: {
    id: websiteSourceId,
    kind: "website" as const,
    name: websiteSourceName,
    externalId: "https://anandaeurope.org",
  },
};

test("expanding a source reveals actions; View documents deep-links to the filtered Documents tab", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    documentList: {
      documents: [sourceDocument],
      total: 1,
      nextCursor: null,
      hasMore: false,
    },
  });

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
            externalId: "https://anandaeurope.org",
            documentCount: 1,
            lastSyncedAt: nowIso,
          },
        ],
      }),
    });
  });

  await page.route("**/backend/api/v1/document/crawl/jobs**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jobs: [
          {
            id: "job-1",
            sourceId: websiteSourceId,
            requestedUrl: "https://anandaeurope.org",
            status: "completed",
            limit: 1000,
            documentCount: 1,
            failedPageCount: 0,
            skippedPageCount: 0,
            failures: [],
            lastError: null,
            createdAt: nowIso,
            updatedAt: nowIso,
            completedAt: nowIso,
          },
        ],
        total: 1,
        nextCursor: null,
        hasMore: false,
      }),
    });
  });

  await page.route(
    `**/backend/api/v1/document/sources/${websiteSourceId}/documents**`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documents: [sourceDocument],
          total: 1,
          nextCursor: null,
          hasMore: false,
        }),
      });
    },
  );

  await page.goto(`/w/${workspaceKey}/knowledge?tab=sources`);

  // Expand the source row.
  const sourceRow = page.getByRole("button", { name: new RegExp(websiteSourceName) }).first();
  await expect(sourceRow).toBeVisible();
  await sourceRow.click();

  // View documents deep-links to the Documents tab with a source filter chip.
  // (Documents is the default knowledge tab, so the URL keeps `?source=…` without an explicit tab param.)
  await page.getByRole("button", { name: "View documents" }).click();
  await expect(page).toHaveURL(/\?(?:.*&)?source=/);
  await expect(page.getByLabel(`Remove source filter: ${websiteSourceName}`)).toBeVisible();

  // The documents list is rendered through the filtered endpoint.
  await page.getByRole("button", { name: /Course Guide/ }).first().click();
  await expect(page.getByRole("button", { name: "Back to documents" }).first()).toBeVisible();

  // Properties panel renamed and shows the source.
  await page.getByRole("button", { name: "Properties" }).click();
  await expect(page.getByText("Source", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(websiteSourceName).last()).toBeVisible();
});

test("connector sources reopen setup with sync status and manual sync", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);

  const connectorSourceId = "55555555-5555-5555-5555-555555555555";
  const connectorDetail = {
    id: "wordpress",
    name: "WordPress",
    description: "Auto-ingest WordPress pages and posts.",
    enabled: true,
    errorStatus: null,
    supportsManualSync: true,
    schema: [
      {
        key: "site_url",
        label: "WordPress site URL",
        type: "text",
        required: true,
      },
    ],
    config: {
      site_url: "https://example.com",
    },
    webhookUrl: "https://radioso.test/api/connectors/wordpress/workspace-1/webhook",
    syncState: {
      backfillCompletedAt: nowIso,
      lastRunAt: nowIso,
      lastModifiedAt: nowIso,
      lastIngestedCount: 4,
      lastErrorStatus: null,
    },
  };

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
            id: connectorSourceId,
            kind: "connector",
            name: "example.com",
            externalId: "wordpress:https://example.com",
            documentCount: 4,
            lastSyncedAt: nowIso,
          },
        ],
      }),
    });
  });

  await page.route("**/backend/api/v1/document/crawl/jobs**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobs: [], total: 0, nextCursor: null, hasMore: false }),
    });
  });

  await page.route("**/backend/api/v1/connectors/wordpress", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(connectorDetail),
    });
  });

  await page.route("**/backend/api/v1/connectors/wordpress/sync", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ingested: 4 }),
    });
  });

  await page.goto(`/w/${workspaceKey}/knowledge?tab=sources`);

  await page.getByText("wordpress:https://example.com").click();
  await page.getByRole("button", { name: "Settings" }).click();

  const dialog = page.getByRole("dialog", { name: /WordPress/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Sync status")).toBeVisible();
  await expect(dialog.getByText("4 documents")).toBeVisible();

  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("Sync completed. 4 documents were ingested.")).toBeVisible();
});
