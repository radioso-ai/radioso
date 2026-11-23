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

const longNote = `Wants ${"a gift wrap on every item, ".repeat(10)}and a note.`;

const billingAttributes = [
  {
    name: "gift_note",
    valueType: "json",
    value: { note: longNote },
    redacted: false,
    scope: "conversation",
    writtenBy: { kind: "api", ref: "credential-1" },
    updatedAt: nowIso,
  },
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
      { key: "returns", label: "Returns", description: null, archived: false },
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

/** Which conversations the backend's attribute filter keeps: billing holds topic "billing", shipping holds none. */
const keptBy = (attribute: string | null, attributeOption: string | null) => (id: string) =>
  !attribute || (attribute === "topic" && (attributeOption === "billing" ? id === billingId : attributeOption === "_not_set" && id === shippingId));

/**
 * The merged history list, answering an attribute filter the way the backend does; records each filter it receives.
 * `refused` is a filter the backend now refuses with a 400, as it does once its attribute is deleted or made Private.
 */
const installAttributeFilteredHistory = async (page: Page, refused?: { attribute: string; attributeOption: string }) => {
  const filters: Array<{ attribute: string | null; attributeOption: string | null }> = [];
  await page.route((url) => url.pathname === "/backend/api/v1/history", async (route) => {
    const url = new URL(route.request().url());
    const attribute = url.searchParams.get("attribute");
    const attributeOption = url.searchParams.get("attributeOption");
    filters.push({ attribute, attributeOption });
    if (refused && attribute === refused.attribute && attributeOption === refused.attributeOption) {
      await route.fulfill({ status: 400, json: { error: { code: "bad_request", message: `No attribute is named ${attribute}` } } });
      return;
    }
    const items = conversations
      .filter((conversation) => keptBy(attribute, attributeOption)(conversation.id))
      .map((conversation) => ({ kind: "chat", id: conversation.id, sortAt: nowIso, conversation }));
    await route.fulfill({ json: { items, total: items.length, nextCursor: null, hasMore: false } });
  });
  return filters;
};

const openConversation = async (page: Page, preview: string) => {
  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  await page.getByRole("button", { name: new RegExp(preview) }).first().click();
};

const pickAttributeFilter = async (page: Page, option: string) => {
  await page.getByRole("combobox", { name: "Filter by attribute" }).click();
  await page.getByRole("option", { name: option }).click();
};

test("the reading pane lists what each attribute holds, who set it, and keeps a Private value out", async ({ page }) => {
  await installMocks(page);
  await openConversation(page, "I was charged twice this month");

  const attributes = page.getByRole("region", { name: "Attributes" });
  await expect(attributes).toBeVisible();
  await expect(attributes.getByText("topic", { exact: true })).toBeVisible();
  await expect(attributes.getByText("Billing", { exact: true })).toBeVisible();
  await expect(attributes.getByText(/^Set by the AI · /)).toBeVisible();
  await expect(attributes.getByText("Pro", { exact: true })).toBeVisible();
  await expect(attributes.getByText(/^Set by your website or API for this visitor · /)).toBeVisible();
  await expect(attributes.getByText("Private data", { exact: true })).toBeVisible();
  // A long value shows a preview, and reads whole on request.
  await expect(attributes.getByText(longNote, { exact: false })).toHaveCount(0);
  await attributes.getByRole("button", { name: "Show all" }).click();
  await expect(attributes.getByText(longNote, { exact: false })).toBeVisible();
  await attributes.getByRole("button", { name: "Show less" }).click();
  if (screenshotDir) await attributes.screenshot({ path: `${screenshotDir}/attributes-reading-pane.png` });
});

test("the reading pane shows no Attributes block for a conversation without any", async ({ page }) => {
  await installMocks(page);
  await openConversation(page, "Where is my parcel?");

  await expect(page.getByText("Let me look into that.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Attributes" })).toHaveCount(0);
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

  await pickAttributeFilter(page, "Attribute: all");

  await expect.poll(() => filters.at(-1)).toEqual({ attribute: null, attributeOption: null });
  await expect(page.getByRole("button", { name: /Where is my parcel\?/ })).toBeVisible();
});

test("an operator narrows the Inbox to conversations where an attribute is not set", async ({ page }) => {
  await installMocks(page);
  const filters = await installAttributeFilteredHistory(page);
  await page.goto(`/w/${workspaceKey}/activity?tab=all`);

  await pickAttributeFilter(page, "Not set");

  await expect.poll(() => filters.at(-1)).toEqual({ attribute: "topic", attributeOption: "_not_set" });
  await expect(page.getByRole("combobox", { name: "Filter by attribute" })).toHaveText("topic: Not set");
  await expect(page.getByRole("button", { name: /Where is my parcel\?/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /I was charged twice this month/ })).toHaveCount(0);
});

test("a filter the backend now refuses is dropped, and the Inbox lists every conversation", async ({ page }) => {
  await installMocks(page);
  const filters = await installAttributeFilteredHistory(page, { attribute: "topic", attributeOption: "billing" });
  await page.goto(`/w/${workspaceKey}/activity?tab=all`);

  await pickAttributeFilter(page, "Billing");

  await expect.poll(() => filters.findIndex((filter) => filter.attributeOption === "billing")).toBeGreaterThan(-1);
  await expect.poll(() => filters.at(-1)).toEqual({ attribute: null, attributeOption: null });
  await expect(page.getByRole("combobox", { name: "Filter by attribute" })).toHaveText("Attribute: all");
  await expect(page.getByRole("button", { name: /Where is my parcel\?/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /I was charged twice this month/ })).toBeVisible();
  await expect(page.getByText("No attribute is named topic")).toHaveCount(0);
});

/** The catalog with a second Choice attribute, which the edit journeys set from "Set attribute" or over the visitor's value. */
const editCatalog = [
  ...catalog,
  catalogVariable("000000000004", "region", {
    options: [{ key: "eu", label: "Europe", description: null, archived: false }],
  }),
];

const editable = (attributes: unknown[]) => ({ ...detail(billingId, "I was charged twice this month", attributes), attributesEditable: true });
const topicAttribute = (overrides: Record<string, unknown>) => ({
  name: "topic",
  valueType: "enum",
  value: "billing",
  option: { label: "Billing", archived: false },
  redacted: false,
  scope: "conversation",
  writtenBy: { kind: "classifier", ref: "context-classification/1" },
  updatedAt: nowIso,
  classified: true,
  ...overrides,
});

/** Answers the Inbox's attribute edits the way the backend does, and records each one. */
const installAttributeEdits = async (page: Page, { resetQueuesClassification = false } = {}) => {
  const edits: Array<{ method: string; name: string; value?: unknown }> = [];
  await page.route(new RegExp(`/backend/api/v1/history/chat/${billingId}/attributes/[^/?]+$`), async (route) => {
    const request = route.request();
    const name = decodeURIComponent(new URL(request.url()).pathname.split("/").at(-1) ?? "");
    if (request.method() === "PUT") {
      const { value } = request.postDataJSON() as { value: string };
      edits.push({ method: "PUT", name, value });
      const options = (editCatalog.find((variable) => variable.name === name)?.options ?? []) as Array<{ key: string; label: string }>;
      const label = options.find((option) => option.key === value)?.label;
      await route.fulfill({
        json: {
          attribute: topicAttribute({
            name,
            value,
            option: { label, archived: false },
            writtenBy: { kind: "operator", ref: "user-1" },
            classified: name === "topic",
          }),
          classificationQueued: false,
        },
      });
      return;
    }
    edits.push({ method: "DELETE", name });
    await route.fulfill({ json: { attribute: null, classificationQueued: resetQueuesClassification && name === "topic" } });
  });
  return edits;
};

test("a teammate sets an attribute the AI chose, then hands it back to the AI", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyItems: { items: [{ kind: "chat", id: billingId, sortAt: nowIso, conversation: conversations[0] }], total: 1, nextCursor: null, hasMore: false },
    conversationDetails: { [billingId]: editable([topicAttribute({})]) },
    contextVariables: editCatalog,
  });
  const edits = await installAttributeEdits(page);
  await openConversation(page, "I was charged twice this month");
  const attributes = page.getByRole("region", { name: "Attributes" });

  const trigger = attributes.getByRole("button", { name: "Change topic" });
  await trigger.click();
  // Only the active options are offered; an archived one names stored values but can't be set.
  await expect(page.getByRole("menuitemradio", { name: "Shipping" })).toHaveCount(0);
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/attributes-edit-menu.png` });
  await page.getByRole("menuitemradio", { name: "Returns" }).click();

  await expect.poll(() => edits).toEqual([{ method: "PUT", name: "topic", value: "returns" }]);
  await expect(attributes.getByText("Returns", { exact: true })).toBeVisible();
  await expect(attributes.getByText(/^Set by your team · /)).toBeVisible();
  await expect(trigger).toBeFocused();

  // A teammate's own value is not offered to keep as the team's again.
  await trigger.click();
  await expect(page.getByText("keeps it as your team's value")).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Reset to automatic" }).click();

  await expect.poll(() => edits.at(-1)).toEqual({ method: "DELETE", name: "topic" });
  await expect(attributes.getByText("Returns", { exact: true })).toHaveCount(0);

  // With no value left, the attribute is offered under Set attribute.
  await attributes.getByRole("button", { name: "Set attribute" }).click();
  await page.getByRole("menuitem", { name: "topic" }).click();
  await page.getByRole("menuitem", { name: "Billing" }).click();

  await expect.poll(() => edits.at(-1)).toEqual({ method: "PUT", name: "topic", value: "billing" });
  await expect(attributes.getByText("Billing", { exact: true })).toBeVisible();
  if (screenshotDir) await attributes.screenshot({ path: `${screenshotDir}/attributes-edited.png` });
});

test("a teammate clears a value they set where nothing fills it, and reads that a set replaces the visitor's value", async ({ page }) => {
  await seedDashboardStorage(page);
  const region = topicAttribute({
    name: "region", value: "eu", option: { label: "Europe", archived: false }, scope: "session",
    writtenBy: { kind: "api", ref: "credential-1" }, classified: false,
  });
  await installDashboardApiMocks(page, {
    historyItems: { items: [{ kind: "chat", id: billingId, sortAt: nowIso, conversation: conversations[0] }], total: 1, nextCursor: null, hasMore: false },
    conversationDetails: { [billingId]: editable([region, topicAttribute({ writtenBy: { kind: "operator", ref: "user-1" }, classified: false })]) },
    contextVariables: editCatalog,
  });
  const edits = await installAttributeEdits(page);
  await openConversation(page, "I was charged twice this month");
  const attributes = page.getByRole("region", { name: "Attributes" });

  await attributes.getByRole("button", { name: "Change region" }).click();
  await expect(page.getByText("Replaces the visitor's value here")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Clear" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await attributes.getByRole("button", { name: "Change topic" }).click();
  await expect(page.getByRole("menuitem", { name: "Reset to automatic" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Clear" }).click();

  await expect.poll(() => edits).toEqual([{ method: "DELETE", name: "topic" }]);
  await expect(attributes.getByText("Billing", { exact: true })).toHaveCount(0);
  await expect(attributes.getByText("Europe", { exact: true })).toBeVisible();
});

test("a teammate who may not take conversations over reads the attributes without changing them", async ({ page }) => {
  await installMocks(page);
  await openConversation(page, "I was charged twice this month");
  const attributes = page.getByRole("region", { name: "Attributes" });

  await expect(attributes.getByText("Billing", { exact: true })).toBeVisible();
  await expect(attributes.getByRole("button", { name: "Change topic" })).toHaveCount(0);
  await expect(attributes.getByRole("button", { name: "Set attribute" })).toHaveCount(0);
});

test("a teammate keeps the AI's choice as the team's, and a value the website wrote can be cleared", async ({ page }) => {
  await seedDashboardStorage(page);
  const region = topicAttribute({
    name: "region", value: "eu", option: { label: "Europe", archived: false },
    writtenBy: { kind: "api", ref: "credential-1" }, classified: false,
  });
  await installDashboardApiMocks(page, {
    historyItems: { items: [{ kind: "chat", id: billingId, sortAt: nowIso, conversation: conversations[0] }], total: 1, nextCursor: null, hasMore: false },
    conversationDetails: { [billingId]: editable([region, topicAttribute({})]) },
    contextVariables: editCatalog,
  });
  const edits = await installAttributeEdits(page);
  await openConversation(page, "I was charged twice this month");
  const attributes = page.getByRole("region", { name: "Attributes" });

  await attributes.getByRole("button", { name: "Change region" }).click();
  await expect(page.getByRole("menuitem", { name: "Clear" })).toBeVisible();
  await page.keyboard.press("Escape");

  const trigger = attributes.getByRole("button", { name: "Change topic" });
  await trigger.click();
  await expect(page.getByText("Choosing the current option keeps it as your team's value")).toBeVisible();
  await page.getByRole("menuitemradio", { name: "Billing" }).click();

  await expect.poll(() => edits).toEqual([{ method: "PUT", name: "topic", value: "billing" }]);
  await expect(attributes.getByText(/^Set by your team · /)).toBeVisible();
  await expect(trigger).toBeFocused();
});

test("a reset shows the value the AI fills in afterwards, without a new message", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyItems: { items: [{ kind: "chat", id: billingId, sortAt: nowIso, conversation: conversations[0] }], total: 1, nextCursor: null, hasMore: false },
    conversationDetails: { [billingId]: editable([topicAttribute({ writtenBy: { kind: "operator", ref: "user-1" } })]) },
    contextVariables: editCatalog,
  });
  const edits = await installAttributeEdits(page, { resetQueuesClassification: true });
  let reset = false;
  page.on("request", (request) => { if (request.method() === "DELETE") reset = true; });
  await page.route(new RegExp(`/backend/api/v1/history/chat/${billingId}\\?.*limit=1`), async (route) => {
    if (!reset) return route.fallback();
    await route.fulfill({
      json: editable([topicAttribute({ value: "returns", option: { label: "Returns", archived: false } })]),
    });
  });
  await openConversation(page, "I was charged twice this month");
  const attributes = page.getByRole("region", { name: "Attributes" });

  await attributes.getByRole("button", { name: "Change topic" }).click();
  await page.getByRole("menuitem", { name: "Reset to automatic" }).click();
  await expect.poll(() => edits).toEqual([{ method: "DELETE", name: "topic" }]);
  await expect(attributes.getByText("Billing", { exact: true })).toHaveCount(0);

  await expect(attributes.getByText("Returns", { exact: true })).toBeVisible({ timeout: 8_000 });
  await expect(attributes.getByText(/^Set by the AI · /)).toBeVisible();
});
