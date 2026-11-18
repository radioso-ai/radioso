import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  testExecutionFixtureId,
  workspaceKey,
} from "./dashboard-fixtures";

// Test Chat's sources journey (#1816): a reply grounded on the workspace's documents, such as a
// routine step that answers from them, shows its sources as the public chat and the Inbox do,
// and a source opens its document. The backend is mocked at the test's message stream; the
// document is invented.

const testChatUrl = `/w/${workspaceKey}/agents/${defaultAgentId}?tab=chat`;
const executionId = testExecutionFixtureId(1);
const reply = "The studio is open nine to five on weekdays.";
const document = {
  id: "7c1f2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b",
  title: "Opening hours",
  content: "The studio is open nine to five on weekdays.",
  metadata: {},
  status: "ready",
};

test("an operator sees the sources a Test Chat reply cites and opens one", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { documentDetails: { [document.id]: document } });
  await page.route(/\/backend\/api\/v1\/agents\/[^/]+\/test-executions\/[^/]+\/messages$/, async (route) => {
    const body = route.request().postDataJSON() as { turnId: string; attemptId: string };
    const identity = { executionId, generation: 1, sideId: "side-1-0", turnId: body.turnId, attemptId: body.attemptId };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        { type: "side_started", ...identity },
        { type: "message_delta", ...identity, delta: reply },
        {
          type: "side_completed",
          ...identity,
          messageId: "message-1",
          answer: reply,
          citations: [{ documentId: document.id, chunkId: "2b3c4d5e-6f70-4a81-9b2c-3d4e5f60718a", title: document.title }],
          answerSegments: [{ text: reply, citationIndices: [0] }],
        },
        { type: "execution_completed", executionId, generation: 1, turnId: body.turnId, attemptId: body.attemptId },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    });
  });

  await page.goto(testChatUrl);
  await page.getByPlaceholder("Ask a question...").fill("When is the studio open?");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect(page.getByText(reply).first()).toBeVisible();
  await page.getByRole("button", { name: /^Sources\s*1/ }).click();
  await page.getByRole("button", { name: document.title, exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "View Document" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(document.content)).toBeVisible();
});
