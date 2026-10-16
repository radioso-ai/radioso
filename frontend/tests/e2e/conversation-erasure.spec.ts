import { expect, test, type Page } from "@playwright/test";

import {
  accountId,
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

const conversationId = "33333333-3333-4333-8333-333333333333";

const conversation = {
  id: conversationId,
  agentId: defaultAgentId,
  agentName: "Gioia",
  agentInternalName: null,
  sourceChannel: "website_embed",
  sourceOrigin: "https://www.example.test",
  entryPageUrl: null,
  channelContext: null,
  anonymousSessionId: "erasure-session",
  createdAt: nowIso,
  updatedAt: nowIso,
  messageCount: 2,
  userMessageCount: 1,
  assistantMessageCount: 1,
  preview: "Please delete everything you have about me",
  title: null,
};

const conversationDetail = {
  conversationId,
  workspaceId,
  agentId: defaultAgentId,
  agentName: "Gioia",
  sourceChannel: "website_embed",
  sourceOrigin: "https://www.example.test",
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
  title: null,
  messages: [
    {
      id: "user-message-erasure",
      role: "user" as const,
      source: "customer" as const,
      content: "Please delete everything you have about me",
      createdAt: nowIso,
    },
    {
      id: "assistant-message-erasure",
      role: "assistant" as const,
      source: "ai_agent" as const,
      content: "I have passed your request to the team.",
      createdAt: nowIso,
    },
  ],
};

const installMocks = async (page: Page) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyItems: {
      items: [{ kind: "chat", id: conversationId, sortAt: nowIso, conversation }],
      total: 1,
      nextCursor: null,
      hasMore: false,
    },
    conversationDetails: { [conversationId]: conversationDetail },
  });
};

/** The erasure endpoint, and the history reads as they answer once the conversation is gone. */
const installErasure = async (page: Page) => {
  const state = { deleteRequests: 0, deleted: false };
  await page.route("**/backend/api/v1/history**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (request.method() === "DELETE" && path === `/history/chat/${conversationId}`) {
      state.deleteRequests += 1;
      state.deleted = true;
      await route.fulfill({ status: 204 });
      return;
    }
    if (state.deleted && request.method() === "GET" && path === "/history") {
      await route.fulfill({ json: { items: [], total: 0, nextCursor: null, hasMore: false } });
      return;
    }
    if (state.deleted && request.method() === "GET" && path.startsWith(`/history/chat/${conversationId}`)) {
      await route.fulfill({ status: 404, json: { error: { code: "not_found", message: "Conversation not found" } } });
      return;
    }
    await route.fallback();
  });
  return state;
};

const openDrawer = async (page: Page) => {
  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  await page.getByRole("button", { name: /Please delete everything you have about me/ }).click();
  // The All lens reads a conversation inline; the drawer opens from "Open in debug view".
  await page.getByRole("button", { name: "Open in debug view" }).click();
};

test("an admin deletes a conversation from the drawer after confirming it is permanent", async ({ page }) => {
  await installMocks(page);
  const erasure = await installErasure(page);
  await openDrawer(page);

  await page.getByRole("button", { name: "Delete conversation" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("Delete this conversation permanently?")).toBeVisible();

  // Cancelling erases nothing.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(erasure.deleteRequests).toBe(0);

  await page.getByRole("button", { name: "Delete conversation" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete permanently" }).click();

  await expect(page.getByRole("alertdialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "Delete conversation" })).toBeHidden();
  expect(erasure.deleteRequests).toBe(1);
  // The list drops the conversation, and the reading pane says it is gone.
  await expect(page.getByRole("button", { name: /Please delete everything you have about me/ })).toBeHidden();
  await expect(page.getByLabel("Response", { exact: true }).getByText("This conversation is no longer available.")).toBeVisible();
});

test("a member reads the conversation but is not offered the delete", async ({ page }) => {
  await installMocks(page);
  await page.route("**/backend/api/v1/account/accounts", async (route) => {
    await route.fulfill({
      json: { accounts: [{ accountId, organizationName: "Radioso Test", role: "member", status: "active" }] },
    });
  });
  await openDrawer(page);

  await expect(page.getByText("Please delete everything you have about me").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete conversation" })).toHaveCount(0);
});
