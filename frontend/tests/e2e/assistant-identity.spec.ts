import { expect, test } from "@playwright/test";

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

// Visitors kept asking whether they had reached a person, so the chat surfaces
// name the assistant and mark it as software on its first message. The settings
// preview renders the same components the visitor sees.
test("chat preview names the assistant and marks it as AI on its first message", async ({
  page,
}) => {
  const platformSettings = basePlatformSettings();
  platformSettings.channels.websiteEmbedEnabled = true;

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { platformSettings });

  await page.goto(
    `/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=web-chat`,
  );

  const preview = page.getByRole("complementary", { name: "Assistant preview" });
  await expect(preview).toBeVisible();

  const identity = preview.getByTestId("assistant-identity");
  await expect(identity).toHaveCount(1);
  await expect(identity).toContainText("Marta");
  await expect(identity).toContainText("AI");

  // It marks the assistant's presence once, not every turn.
  await expect(
    preview.locator('[data-message-id="preview-assistant-1"]').getByTestId(
      "assistant-identity",
    ),
  ).toBeVisible();
  await expect(
    preview.locator('[data-message-id="preview-assistant-2"]').getByTestId(
      "assistant-identity",
    ),
  ).toHaveCount(0);
});

// The workbench is where an operator rehearses the visitor's chat, so it carries
// the same identity line the visitor sees.
test("workbench marks the agent's first reply as AI", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);

  // The workbench bootstraps its session through the assistant endpoint before the
  // composer mounts; without this route it stays on the loading state.
  await page.route("**/backend/api/v1/assistant/chat", async (route) => {
    const body = route.request().postDataJSON() as {
      message?: string;
      startConversation?: boolean;
    };
    const answer = body.startConversation
      ? "Hello, how can I help?"
      : `Chat answer: ${body.message}`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversationId: "11111111-1111-4111-8111-111111111111",
        assistantMessageId: "33333333-3333-4333-8333-333333333333",
        answer,
        citations: [],
        answerSegments: [{ text: answer }],
      }),
    });
  });

  await page.route("**/api/chat/stream", async (route) => {
    const body = route.request().postDataJSON() as { query?: string; message?: string };
    const answer = `Chat answer: ${body.query ?? body.message ?? ""}`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversationId: "11111111-1111-4111-8111-111111111111",
        assistantMessageId: "33333333-3333-4333-8333-333333333333",
        answer,
        citations: [],
        answerSegments: [{ text: answer }],
      }),
    });
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=chat`);
  await page.getByPlaceholder("Ask a question...").fill("Are you a person?");
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText("Chat answer: Are you a person?")).toBeVisible();
  const identity = page.getByTestId("assistant-identity");
  await expect(identity).toHaveCount(1);
  await expect(identity).toContainText("AI");
});
