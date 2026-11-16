import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test.describe.configure({ mode: "serial" });

const freshWorkspaceSummary = () => ({
  documentCount: 0,
  readyDocumentCount: 0,
  pendingDocumentCount: 0,
  sampleDocumentCount: 0,
  sampleDocumentSlugs: [],
  conversationCount: 0,
  hasDocuments: false,
  hasPendingDocuments: false,
  hasReadyDocuments: false,
  hasCompletedChat: false,
  sampleDocumentsImported: false,
  websiteCrawlerEnabled: true,
  setup: {
    purpose: null,
    dismissed: false,
    skippedSteps: [],
    shouldShowFirstRun: true,
    hasDirectivesOrRoutines: false,
    hasNotifyDestination: false,
    hasNotifyDeliveryConfirmed: false,
    hasCredential: false,
  },
});

test("first-run developer paths expose separate upload and chat instructions", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    documentList: {
      documents: [],
      total: 0,
      nextCursor: null,
      hasMore: false,
    },
    workspaceSummary: freshWorkspaceSummary(),
  });

  // First-run onboarding is scoped to the agent's Test chat (dashboard-shell.tsx's
  // isAgentChatView), not the bare workspace root or Build — so this needs an explicit path.
  await page.goto(`/w/${workspaceKey}/agents?tab=chat`);

  await expect(page.getByRole("heading", { name: "Get started with Radioso" })).toBeVisible();
  const uploadApiButton = page.getByRole("button", { name: "Upload with API or SDK" });
  const chatApiButton = page.getByRole("button", { name: "Chat with API or SDK" });
  await uploadApiButton.click();
  await expect(uploadApiButton).toHaveAttribute("aria-expanded", "true");
  await expect(chatApiButton).toHaveAttribute("aria-expanded", "false");

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Upload documents with the API or SDK")).toBeVisible();
  await expect(page.getByText("curl -sS -X POST http://localhost:8080/api/v1/document")).toBeVisible();
  await expect(page.getByText("client.documents.importFile")).toHaveCount(0);
  await expect(page.getByText("Create a credential in Settings → API access.").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy create from text with curl instruction" })).toBeVisible();
  await page.getByRole("button", { name: /^TypeScript$/ }).first().click();
  await expect(page.getByText("client.documents.create")).toBeVisible();
  await expect(page.getByText("apiToken: 'YOUR_PERSONAL_OR_SERVICE_CREDENTIAL'").first()).toBeVisible();

  await chatApiButton.click();
  await expect(uploadApiButton).toHaveAttribute("aria-expanded", "true");
  await expect(chatApiButton).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Ask questions with the API or SDK")).toBeVisible();
  await expect(page.getByText("const response = await client.chat.create({")).toBeVisible();
  await expect(page.getByText("client.chat.listHistory")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy ask a question with typescript instruction" })).toBeVisible();

  await uploadApiButton.click();
  await expect(uploadApiButton).toHaveAttribute("aria-expanded", "false");
  await expect(chatApiButton).toHaveAttribute("aria-expanded", "true");
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
    workspaceSummary: freshWorkspaceSummary(),
  });

  // First-run onboarding is scoped to the agent's Test chat (dashboard-shell.tsx's
  // isAgentChatView), not the bare workspace root or Build — so this needs an explicit path.
  await page.goto(`/w/${workspaceKey}/agents?tab=chat`);

  await expect(page.getByRole("heading", { name: "Get started with Radioso" })).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("heading", { name: "Get started with Radioso" })).toBeHidden();

  await page.reload();

  await expect(page.getByRole("heading", { name: "Get started with Radioso" })).toBeHidden();
});

test("first-run dismissal follows server state into a fresh browser context", async ({ page, browser }) => {
  const workspaceSummary = freshWorkspaceSummary();
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { workspaceSummary });
  await page.goto(`/w/${workspaceKey}/agents?tab=chat`);
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("heading", { name: "Get started with Radioso" })).toBeHidden();

  const freshContext = await browser.newContext();
  const freshPage = await freshContext.newPage();
  await seedDashboardStorage(freshPage);
  await installDashboardApiMocks(freshPage, { workspaceSummary });
  await freshPage.goto(`/w/${workspaceKey}/agents?tab=chat`);
  await expect(freshPage.getByRole("heading", { name: "Get started with Radioso" })).toBeHidden();
  await freshContext.close();
});

test("a workspace in first-run still gets every Build page, which onboarding does not cover", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    documentList: { documents: [], total: 0, nextCursor: null, hasMore: false },
    workspaceSummary: freshWorkspaceSummary(),
  });

  // The bare agent link opens Build, Profile, with no onboarding takeover and no wait on it.
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}`);
  await expect(page.getByRole("heading", { name: "Profile", level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Get started with Radioso" })).toHaveCount(0);

  // So does a link into another Build page, such as Ray's "give the agent a rule" step.
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-directives`);
  await expect(page.getByRole("heading", { name: "Directives", level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Get started with Radioso" })).toHaveCount(0);

  // The chat tab is where onboarding lives.
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=chat`);
  await expect(page.getByRole("heading", { name: "Get started with Radioso" })).toBeVisible();
});
