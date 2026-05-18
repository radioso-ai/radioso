import { expect, test } from "@playwright/test";

import {
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

const markdownDocumentContent = [
  "# Course Overview",
  "",
  "## Schedule",
  "",
  "| Day | Topic |",
  "| --- | --- |",
  "| Monday | Setup |",
  "| Tuesday | Modules |",
  "",
  "- [x] Reserve the room",
  "- [ ] Send the welcome email",
  "",
  "```ts",
  'const greeting = "hello"',
  "```",
  "",
  "```",
  "plain fenced block without a language",
  "```",
].join("\n");

const documentFixture = {
  id: "doc-1",
  title: "Course Guide",
  status: "processed",
  ragStatus: "processed",
  createdAt: nowIso,
  updatedAt: nowIso,
  metadata: {},
  sourceKind: "inline_text",
  sourceId: "00000000-0000-0000-0000-000000000001",
};

const documentList = {
  documents: [documentFixture],
  total: 1,
  nextCursor: null,
  hasMore: false,
};

test.describe("document viewer markdown rendering", () => {
  test("renders headings, tables, task lists, and code blocks in view mode", async ({
    page,
  }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page, {
      documentList,
      documentDetails: {
        "doc-1": {
          ...documentFixture,
          content: markdownDocumentContent,
        },
      },
    });

    await page.goto(`/w/${workspaceKey}/knowledge/documents/doc-1`);

    await expect(
      page.getByRole("heading", { name: "Course Overview", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Schedule", level: 2 }),
    ).toBeVisible();
    await expect(page.getByRole("cell", { name: "Monday" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Setup" })).toBeVisible();
    const checkboxes = page.getByRole("checkbox");
    await expect(checkboxes).toHaveCount(2);
    await expect(checkboxes.nth(0)).toBeChecked();
    await expect(checkboxes.nth(1)).not.toBeChecked();
    await expect(
      page.getByText('const greeting = "hello"'),
    ).toBeVisible();
    await expect(
      page.getByText("plain fenced block without a language"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Copy code", exact: true }),
    ).toHaveCount(2);
  });

  test("edit mode returns the textarea, cancel returns the rendered markdown", async ({
    page,
  }) => {
    await seedDashboardStorage(page);
    await installDashboardApiMocks(page, {
      documentList,
      documentDetails: {
        "doc-1": {
          ...documentFixture,
          content: markdownDocumentContent,
        },
      },
    });

    await page.goto(`/w/${workspaceKey}/knowledge/documents/doc-1`);

    await expect(
      page.getByRole("heading", { name: "Course Overview", level: 1 }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Edit" }).click();
    const editor = page.locator("#document-content");
    await expect(editor).toHaveJSProperty("tagName", "TEXTAREA");
    await expect(editor).toHaveValue(markdownDocumentContent);

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("heading", { name: "Course Overview", level: 1 }),
    ).toBeVisible();
  });
});

test("chat history renders fenced code blocks in assistant messages", async ({
  page,
}) => {
  const conversationId = "conversation-1";
  const historyList = {
    conversations: [
      {
        id: conversationId,
        sourceChannel: null,
        sourceOrigin: null,
        anonymousSessionId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        messageCount: 2,
        userMessageCount: 1,
        assistantMessageCount: 1,
        preview: "Show me a code sample",
      },
    ],
    total: 1,
    nextCursor: null,
    hasMore: false,
  };
  const assistantContent = [
    "Here is a TypeScript example:",
    "",
    "```ts",
    'const greeting = "hello"',
    "```",
  ].join("\n");
  const conversationDetail = {
    conversationId,
    workspaceId,
    sourceChannel: null,
    sourceOrigin: null,
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
    messages: [
      {
        id: "user-message-1",
        role: "user",
        content: "Show me a code sample",
        createdAt: nowIso,
      },
      {
        id: "assistant-message-1",
        role: "assistant",
        content: assistantContent,
        createdAt: nowIso,
        citations: [],
        answerSegments: [{ text: assistantContent, citationIndices: [] }],
      },
    ],
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList,
    conversationDetail,
  });

  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByRole("button", { name: /Show me a code sample/ }).click();
  await expect(page).toHaveURL(/itemKind=chat/);

  await expect(
    page.getByText('const greeting = "hello"'),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy code", exact: true })).toBeVisible();
});
