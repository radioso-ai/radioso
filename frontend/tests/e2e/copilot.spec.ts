import { expect, test } from "@playwright/test";

import {
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("opens Copilot, streams activity and an answer, resumes history, and deletes it", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);

  const copilotConversationId = "copilot-conversation-1";
  const turnId = "copilot-turn-1";
  let conversations: Array<{
    id: string;
    title: string | null;
    status: "idle" | "running";
    createdAt: string;
    updatedAt: string;
  }> = [];
  let messages: unknown[] = [];

  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/backend/api/v1", "");

    if (path === "/copilot/availability" && request.method() === "GET") {
      await route.fulfill({ json: { available: true, reason: "ok" } });
      return;
    }
    if (path === "/copilot/conversations" && request.method() === "GET") {
      await route.fulfill({ json: { conversations } });
      return;
    }
    if (path === `/copilot/conversations/${copilotConversationId}` && request.method() === "GET") {
      await route.fulfill({
        json: {
          id: copilotConversationId,
          title: "Why was retrieval skipped?",
          status: "idle",
          createdAt: "2026-08-11T10:00:00.000Z",
          updatedAt: "2026-08-11T10:00:01.000Z",
          messages,
        },
      });
      return;
    }
    if (path === `/copilot/conversations/${copilotConversationId}` && request.method() === "DELETE") {
      conversations = [];
      messages = [];
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (path === "/copilot/turns" && request.method() === "POST") {
      expect(request.headers()["x-workspace-id"]).toBeTruthy();
      const body = JSON.parse(request.postData() ?? "{}") as {
        conversationId: string | null;
        message: string;
        pageContext: { view: string | null; agentId: string | null; conversationId: string | null };
      };
      expect(body.conversationId).toBeNull();
      expect(body.pageContext).toEqual({
        view: "other",
        agentId: null,
        conversationId: null,
      });
      messages = [
        {
          id: "operator-message-1",
          role: "operator",
          content: body.message,
          createdAt: "2026-08-11T10:00:00.000Z",
        },
        {
          id: "copilot-message-1",
          role: "copilot",
          content: "The trace shows retrieval was skipped.",
          createdAt: "2026-08-11T10:00:01.000Z",
          outcome: "completed",
          activity: [{ tool: "Reading conversation trace", outcome: "completed" }],
        },
      ];
      conversations = [{
        id: copilotConversationId,
        title: "Why was retrieval skipped?",
        status: "idle",
        createdAt: "2026-08-11T10:00:00.000Z",
        updatedAt: "2026-08-11T10:00:01.000Z",
      }];
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          `event: conversation\ndata: ${JSON.stringify({ conversationId: copilotConversationId, turnId })}`,
          `event: activity\ndata: ${JSON.stringify({ toolCallId: "tool-call-1", tool: "Reading conversation trace", stage: "started" })}`,
          `event: activity\ndata: ${JSON.stringify({ toolCallId: "tool-call-1", tool: "Reading conversation trace", stage: "completed" })}`,
          "event: chunk\ndata: {\"text\":\"The trace shows retrieval was skipped.\"}",
          "event: outcome\ndata: {\"status\":\"completed\"}",
          "event: done\ndata: {}",
        ].join("\n\n") + "\n\n",
      });
      return;
    }

    await route.continue();
  });

  await page.goto(`/w/${workspaceKey}/copilot`);
  await expect(page.getByRole("heading", { name: "Copilot" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Copilot" })).toBeVisible();

  await page.getByRole("textbox", { name: "Ask Copilot" }).fill("Why was retrieval skipped?");
  await page.getByRole("button", { name: "Send question" }).click();

  await expect(page.getByText("Reading conversation trace").first()).toBeVisible();
  await expect(page.getByText("The trace shows retrieval was skipped.").first()).toBeVisible();

  await page.getByRole("button", { name: "Why was retrieval skipped?" }).click();
  await expect(page.getByText("Completed").first()).toBeVisible();

  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Your copilot conversations appear here.")).toBeVisible();
});
