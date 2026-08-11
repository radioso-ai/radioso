import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
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
        pageContext: {
          view: string | null;
          agentId: string | null;
          conversationId: string | null;
          selection: string | null;
          entities: Array<{ type: string; id: string; label: string; focused: boolean }>;
        };
      };
      expect(body.conversationId).toBeNull();
      expect(body.pageContext).toEqual({
        view: "copilot",
        agentId: null,
        conversationId: null,
        selection: null,
        entities: [],
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
  await page.getByRole("button", { name: "Delete conversation" }).click();
  await expect(page.getByText("Your copilot conversations appear here.")).toBeVisible();
});

test("summons Copilot from Activity with ambient conversation context and links activity", async ({ page }) => {
  const conversationId = "conversation-ambient-1";
  const copilotConversationId = "copilot-ambient-1";
  const historyList = {
    conversations: [{
      id: conversationId,
      agentId: defaultAgentId,
      agentName: "Marta",
      agentInternalName: "",
      sourceChannel: null,
      sourceOrigin: null,
      anonymousSessionId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      preview: "Why did this conversation route to retrieval?",
    }],
    total: 1,
    nextCursor: null,
    hasMore: false,
  };
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { historyList });
  let messages: unknown[] = [];

  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability" && request.method() === "GET") {
      await route.fulfill({ json: { available: true, reason: "ok" } });
      return;
    }
    if (path === "/copilot/conversations" && request.method() === "GET") {
      await route.fulfill({ json: { conversations: messages.length ? [{ id: copilotConversationId, title: "Explain this route", status: "idle", createdAt: nowIso, updatedAt: nowIso }] : [] } });
      return;
    }
    if (path === `/copilot/conversations/${copilotConversationId}` && request.method() === "GET") {
      await route.fulfill({ json: { id: copilotConversationId, title: "Explain this route", status: "idle", createdAt: nowIso, updatedAt: nowIso, messages } });
      return;
    }
    if (path === "/copilot/turns" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { message: string; pageContext: { view: string; entities: unknown[] } };
      expect(body.pageContext.view).toBe("history");
      expect(body.pageContext.entities).toEqual(expect.arrayContaining([{ type: "conversation", id: conversationId, label: "Why did this conversation route to retrieval?", focused: false }]));
      messages = [
        { id: "operator-ambient", role: "operator", content: body.message, createdAt: nowIso },
        { id: "answer-ambient", role: "copilot", content: "The conversation used retrieval.", createdAt: nowIso, outcome: "completed", activity: [{ tool: "Reading conversation trace", outcome: "completed", entity: { type: "conversation", id: conversationId } }] },
      ];
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `event: conversation\ndata: ${JSON.stringify({ conversationId: copilotConversationId, turnId: "turn-ambient" })}\n\n` +
          `event: activity\ndata: ${JSON.stringify({ toolCallId: "tool-ambient", tool: "Reading conversation trace", stage: "completed", entity: { type: "conversation", id: conversationId } })}\n\n` +
          "event: chunk\ndata: {\"text\":\"The conversation used retrieval.\"}\n\n" +
          "event: outcome\ndata: {\"status\":\"completed\"}\n\n" +
          "event: done\ndata: {}\n\n",
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  await expect(page.getByText("Why did this conversation route to retrieval?").first()).toBeVisible();
  await page.getByRole("button", { name: "Open Copilot" }).click();
  await page.getByRole("textbox", { name: "Ask Copilot" }).fill("Explain this conversation");
  await page.getByRole("button", { name: "Send question" }).click();
  await expect(page.getByText("The conversation used retrieval.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Why did this conversation route to retrieval?" })).toBeVisible();
});

test("asks Copilot about selected dashboard text", async ({ page }) => {
  const selectedText = "Why did this conversation route to retrieval?";
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: { conversations: [{ id: "conversation-selection", agentId: defaultAgentId, preview: selectedText, createdAt: nowIso, updatedAt: nowIso, messageCount: 2, userMessageCount: 1, assistantMessageCount: 1 }], total: 1, nextCursor: null, hasMore: false },
  });
  let selectionReceived: string | null = null;
  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability") return route.fulfill({ json: { available: true, reason: "ok" } });
    if (path === "/copilot/conversations") return route.fulfill({ json: { conversations: [] } });
    if (path === "/copilot/turns" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { pageContext: { selection: string | null } };
      selectionReceived = body.pageContext.selection;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          "event: conversation\ndata: {\"conversationId\":\"copilot-selection\",\"turnId\":\"turn-selection\"}",
          "event: chunk\ndata: {\"text\":\"Selection received.\"}",
          "event: outcome\ndata: {\"status\":\"completed\"}",
          "event: done\ndata: {}",
        ].join("\n\n") + "\n\n",
      });
      return;
    }
    await route.continue();
  });
  await page.goto(`/w/${workspaceKey}/activity?tab=all`);
  await page.getByText(selectedText).first().selectText();
  await page.getByRole("button", { name: "Ask Copilot" }).click();
  await expect(page.getByRole("textbox", { name: "Ask Copilot" })).toHaveValue(new RegExp(selectedText));
  await page.getByRole("button", { name: "Send question" }).click();
  await expect.poll(() => selectionReceived).toBe(selectedText);
});

test("retries a failed Copilot turn with the same message", async ({ page }) => {
  const copilotConversationId = "copilot-retry-1";
  let turnCount = 0;
  let messages: unknown[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability") return route.fulfill({ json: { available: true, reason: "ok" } });
    if (path === "/copilot/conversations" && request.method() === "GET") return route.fulfill({ json: { conversations: messages.length ? [{ id: copilotConversationId, title: "Retry this", status: "idle", createdAt: nowIso, updatedAt: nowIso }] : [] } });
    if (path === `/copilot/conversations/${copilotConversationId}` && request.method() === "GET") return route.fulfill({ json: { id: copilotConversationId, title: "Retry this", status: "idle", createdAt: nowIso, updatedAt: nowIso, messages } });
    if (path === "/copilot/turns" && request.method() === "POST") {
      turnCount += 1;
      const body = JSON.parse(request.postData() ?? "{}") as { message: string };
      messages = [{ id: `operator-retry-${turnCount}`, role: "operator", content: body.message, createdAt: nowIso }, { id: `answer-retry-${turnCount}`, role: "copilot", content: turnCount === 1 ? "The first attempt failed." : "The retry completed.", createdAt: nowIso, outcome: turnCount === 1 ? "failed" : "completed", activity: [] }];
      const status = turnCount === 1 ? "failed" : "completed";
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          `event: conversation\ndata: ${JSON.stringify({ conversationId: copilotConversationId, turnId: `turn-retry-${turnCount}` })}`,
          `event: chunk\ndata: ${JSON.stringify({ text: turnCount === 1 ? "The first attempt failed." : "The retry completed." })}`,
          `event: outcome\ndata: ${JSON.stringify({ status })}`,
          "event: done\ndata: {}",
        ].join("\n\n") + "\n\n",
      });
      return;
    }
    await route.continue();
  });
  await page.goto(`/w/${workspaceKey}/copilot`);
  await page.getByRole("textbox", { name: "Ask Copilot" }).fill("Try this again");
  await page.getByRole("button", { name: "Send question" }).click();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("The retry completed.")).toBeVisible();
  expect(turnCount).toBe(2);
});
