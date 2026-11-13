import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

// An operator turns pictures in answers on from the agent's Profile, and sees on a document which
// pictures its content named and which ones Radioso kept.

// A 1x1 GIF the browser decodes, served as the stored copy: the route's content is not what this spec checks.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=", "base64");
const coverId = "3f6c2b9e-1d4a-4c8e-9b7a-2e5d8f1a6c40";
const coverSrc = `https://agents.shop.example/backend/api/v1/public/reply-images/${coverId}/640`;

test("turning on pictures in answers saves the agent's setting", async ({ page }) => {
  const agentUpdates: unknown[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), agentUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`);

  const pictures = page.getByRole("switch", { name: "Show pictures in answers" });
  await expect(pictures).not.toBeChecked();
  await pictures.click();

  await expect
    .poll(() => agentUpdates.some((update) => (update as { answerImagesEnabled?: boolean }).answerImagesEnabled === true))
    .toBe(true);
  await expect(pictures).toBeChecked();
});

test("a document lists the pictures its content named, with a thumbnail for each one kept", async ({ page }) => {
  const document = {
    id: "doc-1",
    title: "A Field Guide to Alpine Flowers",
    status: "processed",
    ragStatus: "processed",
    createdAt: nowIso,
    updatedAt: nowIso,
    metadata: { sourceUrl: "https://shop.example/books/alpine-flowers" },
    sourceKind: "inline_text",
    sourceId: "00000000-0000-0000-0000-000000000001",
  };
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    documentList: { documents: [document], total: 1, nextCursor: null, hasMore: false },
    documentDetails: {
      "doc-1": {
        ...document,
        content: "The guide walks through every meadow above the tree line.",
        images: [
          {
            id: coverId, role: "primary", status: "stored", alt: "The cover", caption: null, width: 1200, height: 900,
            sourceUrl: "https://cdn.shop.example/covers/alpine.jpg", src: coverSrc, srcSet: `${coverSrc} 640w`,
          },
          {
            id: "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", role: "inline", status: "skipped", alt: "", caption: null, width: null, height: null,
            sourceUrl: "https://track.shop.example/pixel.gif",
          },
        ],
      },
    },
  });
  await page.route(coverSrc, (route) => route.fulfill({ status: 200, contentType: "image/gif", body: PIXEL }));

  await page.goto(`/w/${workspaceKey}/knowledge/documents/doc-1`);

  const images = page.getByRole("region", { name: "Images" });
  await expect(images.getByRole("img", { name: "The cover" })).toBeVisible();
  await expect(images.getByText("Main picture")).toBeVisible();
  await expect(images.getByText("Not kept")).toBeVisible();
  await expect(images.getByText("In the text")).toBeVisible();
});
