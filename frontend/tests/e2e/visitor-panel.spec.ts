import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

test("the drawer's Visitor panel shows country and previous conversations, and switches the drawer when one is opened", async ({ page }) => {
  const conversationId = "conversation-visitor-current";
  const previousConversationIdA = "conversation-visitor-previous-a";
  const previousConversationIdB = "conversation-visitor-previous-b";
  const visitorId = "22222222-2222-4222-8222-222222222222";

  const conversation = {
    id: conversationId,
    agentId: defaultAgentId,
    agentName: "Gioia",
    agentInternalName: null,
    sourceChannel: "website_embed",
    sourceOrigin: "https://www.example.test",
    entryPageUrl: null,
    channelContext: null,
    anonymousSessionId: "visitor-session-current",
    visitorCountry: "DE",
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    preview: "Wie lange dauert der Versand nach Berlin?",
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
    entryReferrer: "https://www.google.com/search",
    visitor: {
      id: visitorId,
      firstSeenAt: "2026-04-01T09:00:00.000Z",
      conversationCount: 3,
      verified: false,
    },
    requestContext: {
      clientIp: "203.0.113.9",
      country: "DE",
      region: "BE",
      city: "Berlin",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      acceptLanguage: "de-DE,de;q=0.9",
      observedVia: "edge_proof",
    },
    messages: [
      {
        id: "user-message-visitor",
        role: "user" as const,
        source: "customer" as const,
        content: "Wie lange dauert der Versand nach Berlin?",
        createdAt: nowIso,
      },
      {
        id: "assistant-message-visitor",
        role: "assistant" as const,
        source: "ai_agent" as const,
        content: "Der Versand dauert 3 bis 5 Tage.",
        createdAt: nowIso,
      },
    ],
  };

  const previousConversationA = {
    id: previousConversationIdA,
    agentId: defaultAgentId,
    agentName: "Gioia",
    agentInternalName: null,
    sourceChannel: "website_embed",
    sourceOrigin: "https://www.example.test",
    channelContext: null,
    anonymousSessionId: "visitor-session-a",
    entryPageUrl: null,
    visitorCountry: "DE",
    createdAt: "2026-04-02T09:00:00.000Z",
    updatedAt: "2026-04-02T09:00:00.000Z",
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    preview: "Gibt es Rabatt für Studenten?",
    title: "Rabatt für Studenten",
  };
  const previousConversationB = {
    ...previousConversationA,
    id: previousConversationIdB,
    preview: "Wo bleibt meine Bestellung?",
    title: "Bestellstatus",
    createdAt: "2026-04-03T09:00:00.000Z",
    updatedAt: "2026-04-03T09:00:00.000Z",
  };

  const previousConversationBDetail = {
    conversationId: previousConversationIdB,
    workspaceId,
    agentId: defaultAgentId,
    agentName: "Gioia",
    sourceChannel: "website_embed",
    sourceOrigin: "https://www.example.test",
    channelContext: null,
    createdAt: previousConversationB.createdAt,
    updatedAt: previousConversationB.updatedAt,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    messagesTotal: 2,
    messageWindowOffset: 0,
    messageWindowLimit: 50,
    hasOlderMessages: false,
    nextCursor: null,
    title: previousConversationB.title,
    messages: [
      {
        id: "user-message-previous-b",
        role: "user" as const,
        source: "customer" as const,
        content: "Wo bleibt meine Bestellung?",
        createdAt: previousConversationB.createdAt,
      },
      {
        id: "assistant-message-previous-b",
        role: "assistant" as const,
        source: "ai_agent" as const,
        content: "Ihre Bestellung ist unterwegs.",
        createdAt: previousConversationB.createdAt,
      },
    ],
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyItems: {
      items: [
        { kind: "chat", id: conversation.id, sortAt: conversation.updatedAt, conversation },
      ],
      total: 1,
      nextCursor: null,
      hasMore: false,
    },
    conversationDetails: {
      [conversationId]: conversationDetail,
      [previousConversationIdB]: previousConversationBDetail,
    },
    visitorConversations: {
      [visitorId]: {
        conversations: [previousConversationB, previousConversationA],
        total: 2,
        nextCursor: null,
        hasMore: false,
      },
    },
  });

  await page.goto(`/w/${workspaceKey}/activity?tab=all`);

  // FR-043: the Activity row's Source cell shows the country code after the channel word.
  const row = page.getByRole("button", { name: /Wie lange dauert der Versand/ });
  await expect(row).toContainText("DE");

  await row.click();
  // The All lens reads a conversation inline; the drawer (where the Visitor panel
  // lives, alongside turn diagnostics) opens from "Open in debug view".
  await page.getByRole("button", { name: "Open in debug view" }).click();

  await expect(page.getByText("Visitor", { exact: true })).toBeVisible();
  // FR-042: country/region/city, combined — distinct text from the row's bare country code.
  await expect(page.getByText("Berlin, BE, DE")).toBeVisible();
  await expect(page.getByText("Chrome · Windows")).toBeVisible();
  await expect(page.getByText("de", { exact: true })).toBeVisible();
  await expect(page.getByText("203.0.113.9")).toBeVisible();

  // Both previous conversations are listed, newest first.
  await expect(page.getByText("Bestellstatus")).toBeVisible();
  await expect(page.getByText("Rabatt für Studenten")).toBeVisible();

  await page.getByRole("button", { name: /Bestellstatus/ }).click();
  await expect(page.getByText("Ihre Bestellung ist unterwegs.")).toBeVisible();
});
