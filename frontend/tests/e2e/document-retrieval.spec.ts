import { expect, test } from "@playwright/test";

import {
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

const websiteSourceId = "55555555-5555-5555-5555-555555555555";

const baseDoc = {
  status: "ready",
  ragStatus: "processed",
  createdAt: nowIso,
  updatedAt: nowIso,
  metadata: {},
  sourceKind: "inline_text" as const,
};

const includedDoc = {
  ...baseDoc,
  id: "doc-included",
  title: "Included Doc",
  retrievalEnabled: true,
  retrievalExpiresAt: null,
};

const excludedDoc = {
  ...baseDoc,
  id: "doc-excluded",
  title: "Excluded Doc",
  retrievalEnabled: false,
  retrievalExpiresAt: null,
};

const websiteDoc = {
  ...baseDoc,
  id: "doc-website",
  title: "Crawled Doc",
  sourceId: websiteSourceId,
  source: {
    id: websiteSourceId,
    kind: "website" as const,
    name: "example.org",
    externalId: "https://example.org/very/long/path/that/should/truncate",
  },
  retrievalEnabled: true,
  retrievalExpiresAt: null,
};

test("shows a source column and an excluded status, and toggles retrieval from the detail panel", async ({
  page,
}) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    documentList: {
      documents: [includedDoc, excludedDoc, websiteDoc],
      total: 3,
      nextCursor: null,
      hasMore: false,
    },
  });

  let patchBody: unknown = null;
  await page.route("**/backend/api/v1/document/doc-included", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    patchBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...includedDoc, content: "Body", retrievalEnabled: false }),
    });
  });

  await page.goto(`/w/${workspaceKey}/knowledge`);

  // 1. Source column is present and shows the website source label.
  await expect(page.getByRole("columnheader", { name: "Source" })).toBeVisible();
  await expect(page.getByText("https://example.org/very/long/path/that/should/truncate")).toBeVisible();

  // 2. The excluded document stays in the list but stands out with a status badge.
  const excludedRow = page.getByRole("row").filter({ hasText: "Excluded Doc" });
  await expect(excludedRow.getByText("Excluded", { exact: true })).toBeVisible();

  // 3. Opening a document exposes the retrieval toggle, and flipping it off
  //    issues a PATCH that excludes the document from retrieval.
  await page.getByRole("button", { name: "Included Doc", exact: true }).click();
  await page.getByRole("button", { name: "Properties" }).click();

  const toggle = page.getByRole("switch", { name: "Available for retrieval" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();

  await expect.poll(() => patchBody).toEqual({ retrievalEnabled: false });
});
