import { expect, test, type Page } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

const conversationId = "44444444-4444-4444-8444-444444444444";
const recordId = "55555555-5555-4555-8555-555555555555";
const declinedRecordId = "66666666-6666-4666-8666-666666666666";
const withdrawnAt = "2026-11-12T10:00:00.000Z";
const screenshotDir = process.env.CONSENT_SCREENSHOT_DIR;

const conversation = {
  id: conversationId,
  agentId: defaultAgentId,
  agentName: "Sola",
  agentInternalName: null,
  sourceChannel: "website_embed",
  sourceOrigin: "https://www.classes.example",
  entryPageUrl: null,
  channelContext: null,
  anonymousSessionId: "consent-session",
  createdAt: nowIso,
  updatedAt: nowIso,
  messageCount: 6,
  userMessageCount: 3,
  assistantMessageCount: 3,
  preview: "I want to book a class",
  title: null,
};

const wording = {
  body: "We ask about injuries only to adapt your class. Your answer stays with this booking.",
  agreeLabel: "I agree",
  declineLabel: "No thanks",
};

const grantedRecord = {
  id: recordId,
  routineId: "routine-class-booking",
  consentKey: "health",
  slotKeys: ["injury"],
  decision: "granted",
  method: "button",
  defaulted: false,
  locale: "en",
  channel: "website_embed",
  wordingVersionId: "wording-version-1",
  wording,
  decidedAt: nowIso,
  withdrawnAt: null,
};

const declinedRecord = {
  ...grantedRecord,
  id: declinedRecordId,
  consentKey: "diet",
  slotKeys: ["diet"],
  decision: "declined",
  method: "reply",
  wording: { body: "We ask about your diet only to plan the class snacks.", agreeLabel: "Fine", declineLabel: "Rather not" },
};

const message = (id: string, role: "user" | "assistant", content: string) => ({
  id,
  role,
  source: role === "user" ? "customer" : "ai_agent",
  content,
  createdAt: nowIso,
});

const messages = [
  message("message-1", "user", "I want to book a class"),
  message("message-2", "assistant", wording.body),
  message("message-3", "user", "I agree"),
  message("message-4", "assistant", "Do you have any injury we should know about?"),
  message("message-5", "user", "I have a sore knee"),
  message("message-6", "assistant", "Thanks, I noted the sore knee. When would you like to come?"),
];

const withheld = { reason: "consent_withdrawn", at: withdrawnAt };
// The grant's turn and the injury's turn carried the covered value; the server withholds both.
const withheldMessages = messages.map((entry) =>
  ["message-3", "message-4", "message-5", "message-6"].includes(entry.id) ? { ...entry, content: "[redacted]", withheld } : entry);

const detailWith = (threadMessages: typeof messages) => ({
  conversationId,
  workspaceId,
  agentId: defaultAgentId,
  agentName: "Sola",
  sourceChannel: "website_embed",
  sourceOrigin: "https://www.classes.example",
  channelContext: null,
  createdAt: nowIso,
  updatedAt: nowIso,
  messageCount: 6,
  userMessageCount: 3,
  assistantMessageCount: 3,
  messagesTotal: 6,
  messageWindowOffset: 0,
  messageWindowLimit: 50,
  hasOlderMessages: false,
  nextCursor: null,
  title: null,
  messages: threadMessages,
});

const installEffectiveRole = async (page: Page, effectiveRole: "owner" | "admin" | "member") => {
  await page.route(`**/backend/api/v1/account/workspaces/${workspaceId}/api-access`, async (route) => {
    await route.fulfill({
      json: {
        effectiveRole,
        capabilities: { manageOwnPersonalTokens: true, auditWorkspacePersonalTokens: false, manageServiceAccounts: effectiveRole !== "member" },
        defaults: { personalTokenLifetimeDays: 90, serviceCredentialLifetimeDays: 365 },
        limits: { personalTokensPerUser: 10, serviceAccountsPerWorkspace: 50, credentialsPerServiceAccount: 5, maximumPageSize: 100 },
        legacyCredentialMigration: { active: false },
      },
    });
  });
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
    conversationDetails: { [conversationId]: detailWith(messages) },
  });
};

/** The consent records and their withdrawal, and the history reads as they answer once it is withdrawn. */
const installConsents = async (page: Page) => {
  const state = { withdrawRequests: 0, withdrawn: false };
  await page.route("**/backend/api/v1/history/chat/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    const granted = state.withdrawn ? { ...grantedRecord, withdrawnAt } : grantedRecord;
    if (request.method() === "GET" && path === `/history/chat/${conversationId}/consents`) {
      await route.fulfill({ json: { consents: [granted, declinedRecord] } });
      return;
    }
    if (request.method() === "POST" && path === `/history/chat/${conversationId}/consents/${recordId}/withdraw`) {
      state.withdrawRequests += 1;
      state.withdrawn = true;
      await route.fulfill({ json: { consent: { ...grantedRecord, withdrawnAt } } });
      return;
    }
    if (state.withdrawn && request.method() === "GET" && path === `/history/chat/${conversationId}/tail`) {
      await route.fulfill({ json: { messages: withheldMessages, cursor: null } });
      return;
    }
    if (state.withdrawn && request.method() === "GET" && path === `/history/chat/${conversationId}`) {
      await route.fulfill({ json: detailWith(withheldMessages) });
      return;
    }
    await route.fallback();
  });
  return state;
};

const openDrawer = async (page: Page) => {
  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  await page.getByRole("button", { name: /I want to book a class/ }).first().click();
  // The All lens reads a conversation inline; the drawer opens from "Open in debug view".
  await page.getByRole("button", { name: "Open in debug view" }).click();
};

const consentsPanel = (page: Page) => page.getByRole("region", { name: "Consents" });

test("an admin withdraws a visitor's consent from the drawer, and the messages that carried it read as withheld", async ({ page }) => {
  await installMocks(page);
  await installEffectiveRole(page, "admin");
  const consents = await installConsents(page);
  await openDrawer(page);

  const records = consentsPanel(page).getByTestId("conversation-consent");
  await expect(records).toHaveCount(2);
  const granted = records.nth(0);
  await expect(granted.getByText("Granted")).toBeVisible();
  await expect(granted.getByText(/^en · Embedded · /)).toBeVisible();
  // A declined consent collected nothing, so it offers no withdrawal.
  await expect(records.nth(1).getByText("Declined")).toBeVisible();
  await expect(records.nth(1).getByRole("button", { name: "Withdraw" })).toHaveCount(0);

  await granted.getByRole("button", { name: "Wording" }).click();
  await expect(granted.getByText(wording.body)).toBeVisible();
  if (screenshotDir) await consentsPanel(page).screenshot({ path: `${screenshotDir}/30-consents-panel.png` });

  await granted.getByRole("button", { name: "Withdraw" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("Withdraw this consent?")).toBeVisible();
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/31-withdraw-confirm.png` });

  // Cancelling withdraws nothing.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(consents.withdrawRequests).toBe(0);

  await granted.getByRole("button", { name: "Withdraw" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Withdraw consent" }).click();

  await expect(page.getByRole("alertdialog")).toBeHidden();
  expect(consents.withdrawRequests).toBe(1);
  const withdrawnRecord = consentsPanel(page).getByTestId("conversation-consent").nth(0);
  await expect(withdrawnRecord.getByText("Withdrawn", { exact: true })).toBeVisible();
  await expect(withdrawnRecord.getByText(/Withdrawn .*2026/)).toBeVisible();
  await expect(withdrawnRecord.getByRole("button", { name: "Withdraw" })).toHaveCount(0);
  await expect(page.getByText("Withheld after consent was withdrawn")).toHaveCount(4);
  await expect(page.getByText("I have a sore knee")).toHaveCount(0);
  await expect(page.getByText("I want to book a class").first()).toBeVisible();
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/32-after-withdraw.png` });
});

test("a member reads the consents but is not offered the withdrawal", async ({ page }) => {
  await installMocks(page);
  await installEffectiveRole(page, "member");
  await installConsents(page);
  await openDrawer(page);

  await expect(page.getByTestId("conversation-consent")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Withdraw" })).toHaveCount(0);
});
