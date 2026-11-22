import { expect, test, type Page } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

const billingId = "71111111-1111-4111-8111-111111111111";
const shippingId = "72222222-2222-4222-8222-222222222222";
const screenshotDir = process.env.ATTRIBUTES_SCREENSHOT_DIR;

const summary = (id: string, preview: string) => ({
  id,
  agentId: defaultAgentId,
  agentName: "Sola",
  agentInternalName: null,
  sourceChannel: "website_embed",
  sourceOrigin: "https://shop.example",
  entryPageUrl: null,
  channelContext: null,
  anonymousSessionId: `session-${id}`,
  createdAt: nowIso,
  updatedAt: nowIso,
  messageCount: 2,
  userMessageCount: 1,
  assistantMessageCount: 1,
  preview,
  title: null,
});

const conversations = [
  summary(billingId, "I was charged twice this month"),
  summary(shippingId, "Where is my parcel?"),
];

const detail = (id: string, preview: string, attributes: unknown[]) => ({
  conversationId: id,
  workspaceId,
  agentId: defaultAgentId,
  agentName: "Sola",
  sourceChannel: "website_embed",
  sourceOrigin: "https://shop.example",
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
    { id: `${id}-1`, role: "user", source: "customer", content: preview, createdAt: nowIso },
    { id: `${id}-2`, role: "assistant", source: "ai_agent", content: "Let me look into that.", createdAt: nowIso },
  ],
  attributes,
});

const billingAttributes = [
  {
    name: "health_note",
    valueType: "string",
    value: null,
    redacted: true,
    scope: "conversation",
    writtenBy: { kind: "api", ref: "credential-1" },
    updatedAt: nowIso,
  },
  {
    name: "plan",
    valueType: "string",
    value: "Pro",
    redacted: false,
    scope: "customer",
    writtenBy: { kind: "api", ref: "credential-1" },
    updatedAt: nowIso,
  },
  {
    name: "topic",
    valueType: "enum",
    value: "billing",
    option: { label: "Billing", archived: false },
    redacted: false,
    scope: "conversation",
    writtenBy: { kind: "classifier", ref: "instructions-v1" },
    updatedAt: nowIso,
  },
];

const catalogVariable = (idSuffix: string, name: string, overrides: Record<string, unknown>) => ({
  id: `88888888-8888-4888-8888-${idSuffix}`,
  workspaceId,
  name,
  description: null,
  valueType: "enum" as const,
  options: null,
  trustTier: "unverified" as const,
  sensitivity: "normal" as const,
  defaultSurfacing: "on_reference" as const,
  createdAt: nowIso,
  updatedAt: nowIso,
  ...overrides,
});

const catalog = [
  catalogVariable("000000000001", "topic", {
    options: [
      { key: "billing", label: "Billing", description: null, archived: false },
      { key: "shipping", label: "Shipping", description: null, archived: true },
    ],
  }),
  catalogVariable("000000000002", "injury", {
    sensitivity: "sensitive",
    options: [{ key: "knee", label: "Sore knee", description: null, archived: false }],
  }),
  catalogVariable("000000000003", "plan", { valueType: "string" }),
];

const installMocks = async (page: Page) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyItems: {
      items: conversations.map((conversation) => ({ kind: "chat", id: conversation.id, sortAt: nowIso, conversation })),
      total: conversations.length,
      nextCursor: null,
      hasMore: false,
    },
    conversationDetails: {
      [billingId]: detail(billingId, "I was charged twice this month", billingAttributes),
      [shippingId]: detail(shippingId, "Where is my parcel?", []),
    },
    contextVariables: catalog,
  });
};

/** The merged history list, answering an attribute filter the way the backend does; records each filter it receives. */
const installAttributeFilteredHistory = async (page: Page) => {
  const filters: Array<{ attribute: string | null; attributeOption: string | null }> = [];
  await page.route((url) => url.pathname === "/backend/api/v1/history", async (route) => {
    const url = new URL(route.request().url());
    const attribute = url.searchParams.get("attribute");
    const attributeOption = url.searchParams.get("attributeOption");
    filters.push({ attribute, attributeOption });
    const items = conversations
      .filter((conversation) => !attribute || (attribute === "topic" && attributeOption === "billing" && conversation.id === billingId))
      .map((conversation) => ({ kind: "chat", id: conversation.id, sortAt: nowIso, conversation }));
    await route.fulfill({ json: { items, total: items.length, nextCursor: null, hasMore: false } });
  });
  return filters;
};

const drawer = (page: Page) => page.getByRole("dialog", { name: "Conversation details" });

const openDrawer = async (page: Page, preview: string) => {
  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  await page.getByRole("button", { name: new RegExp(preview) }).first().click();
  await page.getByRole("button", { name: "Open in debug view" }).click();
};

test("the conversation drawer lists what each attribute holds, who set it, and keeps a Private value out", async ({ page }) => {
  await installMocks(page);
  await openDrawer(page, "I was charged twice this month");

  const attributes = drawer(page).getByRole("region", { name: "Attributes" });
  await expect(attributes).toBeVisible();
  await expect(attributes.getByText("topic", { exact: true })).toBeVisible();
  await expect(attributes.getByText("Billing", { exact: true })).toBeVisible();
  await expect(attributes.getByText(/^Set by the AI · /)).toBeVisible();
  await expect(attributes.getByText("Pro", { exact: true })).toBeVisible();
  await expect(attributes.getByText(/^Set by your website or API for this visitor · /)).toBeVisible();
  await expect(attributes.getByText("Private data", { exact: true })).toBeVisible();
  if (screenshotDir) await attributes.screenshot({ path: `${screenshotDir}/attributes-drawer.png` });
});

test("the conversation drawer shows no Attributes block for a conversation without any", async ({ page }) => {
  await installMocks(page);
  await openDrawer(page, "Where is my parcel?");

  await expect(drawer(page).getByText("Let me look into that.")).toBeVisible();
  await expect(drawer(page).getByRole("region", { name: "Attributes" })).toHaveCount(0);
});

test("an operator narrows the Inbox to conversations whose attribute holds one option", async ({ page }) => {
  await installMocks(page);
  const filters = await installAttributeFilteredHistory(page);
  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  await expect(page.getByRole("button", { name: /Where is my parcel\?/ })).toBeVisible();

  await page.getByRole("combobox", { name: "Filter by attribute" }).click();
  // Only Choice attributes that are not Private filter; an archived option still names stored values.
  await expect(page.getByRole("option", { name: "Shipping (archived)" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Sore knee" })).toHaveCount(0);
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/attributes-inbox-filter.png` });
  await page.getByRole("option", { name: "Billing" }).click();

  await expect.poll(() => filters.at(-1)).toEqual({ attribute: "topic", attributeOption: "billing" });
  await expect(page.getByRole("combobox", { name: "Filter by attribute" })).toHaveText("topic: Billing");
  await expect(page.getByRole("button", { name: /I was charged twice this month/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Where is my parcel\?/ })).toHaveCount(0);

  await page.getByRole("combobox", { name: "Filter by attribute" }).click();
  await page.getByRole("option", { name: "Attribute: all" }).click();

  await expect.poll(() => filters.at(-1)).toEqual({ attribute: null, attributeOption: null });
  await expect(page.getByRole("button", { name: /Where is my parcel\?/ })).toBeVisible();
});
