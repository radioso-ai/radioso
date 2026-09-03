import { expect, test } from "@playwright/test";

import {
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test.describe.configure({ mode: "serial" });

test("first-run developer paths expose separate upload and chat instructions", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    documentList: {
      documents: [],
      total: 0,
      nextCursor: null,
      hasMore: false,
    },
  });

  // First-run onboarding is scoped to the Agents chat view (dashboard-shell.tsx's
  // isAgentChatView), not the bare workspace root — the Inbox is the dashboard's
  // default landing section, so this needs an explicit path.
  await page.goto(`/w/${workspaceKey}/agents`);

  await expect(page.getByRole("heading", { name: "Get started with Radioso" })).toBeVisible();
  const uploadApiButton = page.getByRole("button", { name: "Upload with API or SDK" });
  const chatApiButton = page.getByRole("button", { name: "Chat with API or SDK" });
  await uploadApiButton.click();
  await expect(uploadApiButton).toHaveAttribute("aria-expanded", "true");
  await expect(chatApiButton).toHaveAttribute("aria-expanded", "true");

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Upload documents with the API or SDK")).toBeVisible();
  await expect(page.getByText("Ask questions with the API or SDK")).toBeVisible();
  await expect(page.getByText("curl -sS -X POST http://localhost:8080/api/v1/document/")).toBeVisible();
  await expect(page.getByText("curl -sS -X POST http://localhost:8080/api/v1/assistant/chat")).toBeVisible();
  await expect(page.getByText("client.documents.importFile")).toHaveCount(0);
  await expect(page.getByText("Create a credential in Settings → API access.").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy create from text with curl instruction" })).toBeVisible();
  await page.getByRole("button", { name: /^TypeScript$/ }).first().click();
  await expect(page.getByText("client.documents.create")).toBeVisible();
  await expect(page.getByText("const response = await client.chat.create({")).toBeVisible();
  await expect(page.getByText("apiToken: 'YOUR_PERSONAL_OR_SERVICE_CREDENTIAL'").first()).toBeVisible();
  await expect(page.getByText("client.chat.listHistory")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy ask a question with typescript instruction" })).toBeVisible();

  await chatApiButton.click();
  await expect(uploadApiButton).toHaveAttribute("aria-expanded", "false");
  await expect(chatApiButton).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Upload documents with the API or SDK")).toHaveCount(0);
  await expect(page.getByText("Ask questions with the API or SDK")).toHaveCount(0);
});

test("first-run onboarding can be skipped and stays hidden", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    documentList: {
      documents: [],
      total: 0,
      nextCursor: null,
      hasMore: false,
    },
  });

  // First-run onboarding is scoped to the Agents chat view (dashboard-shell.tsx's
  // isAgentChatView), not the bare workspace root — the Inbox is the dashboard's
  // default landing section, so this needs an explicit path.
  await page.goto(`/w/${workspaceKey}/agents`);

  await expect(page.getByRole("heading", { name: "Get started with Radioso" })).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("heading", { name: "Get started with Radioso" })).toBeHidden();

  await page.reload();

  await expect(page.getByRole("heading", { name: "Get started with Radioso" })).toBeHidden();
});
