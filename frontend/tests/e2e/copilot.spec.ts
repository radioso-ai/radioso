import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

test("opens Ray, streams activity and an answer, resumes history, and deletes it", async ({ page }) => {
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
      await route.fulfill({ json: { available: true, reason: "ok", canManage: true, applyableProposalTargets: ["directive","agent_setting","routine","agent_skill","context_variable","document","ingestion_settings","website_crawl"] } });
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
  await expect(page.getByRole("heading", { name: "Hi, I'm Ray ☀️" })).toBeVisible();

  await page.getByRole("textbox", { name: "Ask Ray" }).fill("Why was retrieval skipped?");
  await page.getByRole("button", { name: "Send question" }).click();

  await expect(page.getByText("The trace shows retrieval was skipped.").first()).toBeVisible();
  await expect(page.getByText("Ray").first()).toBeVisible();
  await expect(page.getByRole("img", { name: "Ray" }).first()).toBeVisible();
  await page.getByRole("button", { name: /Looked at 1 source/ }).click();
  await expect(page.getByText("Reading conversation trace").first()).toBeVisible();

  await page.getByRole("button", { name: "Why was retrieval skipped?" }).click();

  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Delete this Ray conversation?" })).toBeVisible();
  await page.getByRole("button", { name: "Delete conversation" }).click();
  await expect(page.getByText("Your Ray conversations appear here.")).toBeVisible();
});

test("summons Ray from Activity with ambient conversation context and links activity", async ({ page }) => {
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
      await route.fulfill({ json: { available: true, reason: "ok", canManage: true, applyableProposalTargets: ["directive","agent_setting","routine","agent_skill","context_variable","document","ingestion_settings","website_crawl"] } });
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
  // The bottom-right tag is the entry point; the panel's own composer sends the question.
  await page.getByTestId("ask-ray-tag").click();
  await expect(page.getByRole("heading", { name: "Ray", exact: true })).toBeVisible();
  // The panel docks beside the activity list (non-modal), so both surfaces show the
  // conversation label — scope the composer and the answer's activity link to the panel.
  const rayPanel = page.getByRole("complementary", { name: "Ray" });
  await rayPanel.getByRole("textbox", { name: "Ask Ray" }).fill("Explain this conversation");
  await rayPanel.getByRole("button", { name: "Send question" }).click();
  await expect(page.getByText("The conversation used retrieval.")).toBeVisible();
  await expect(rayPanel.getByRole("button", { name: "Why did this conversation route to retrieval?" })).toBeVisible();
});

test("asks Ray about selected dashboard text", async ({ page }) => {
  const selectedText = "Why did this conversation route to retrieval?";
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: { conversations: [{ id: "conversation-selection", agentId: defaultAgentId, preview: selectedText, createdAt: nowIso, updatedAt: nowIso, messageCount: 2, userMessageCount: 1, assistantMessageCount: 1 }], total: 1, nextCursor: null, hasMore: false },
  });
  let selectionReceived: string | null = null;
  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability") return route.fulfill({ json: { available: true, reason: "ok", canManage: true, applyableProposalTargets: ["directive","agent_setting","routine","agent_skill","context_variable","document","ingestion_settings","website_crawl"] } });
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
  // The All lens row bundles the title with a timestamp, visitor label, and
  // outcome chip inside one clickable element (spec 1116). locator.selectText()
  // resolved to more than the title span in practice, so build the Range
  // directly against the title's own text node and dispatch selectionchange
  // ourselves (the app listens for that event, not a Playwright-internal one).
  const conversationRow = page.getByRole("button", { name: new RegExp(selectedText) });
  await conversationRow.locator("span").first().evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  // The bottom-right tag exposes the same accessible name, so pick the popover's button.
  await page.getByRole("button", { name: "Ask Ray" }).and(page.locator('button:not([data-testid="ask-ray-tag"])')).click();
  await expect(page.getByRole("textbox", { name: "Ask Ray" })).toHaveValue(new RegExp(selectedText));
  await page.getByRole("button", { name: "Send question" }).click();
  await expect.poll(() => selectionReceived).toBe(selectedText);
});

test("retries a failed Ray turn with the same message", async ({ page }) => {
  const copilotConversationId = "copilot-retry-1";
  let turnCount = 0;
  let messages: unknown[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability") return route.fulfill({ json: { available: true, reason: "ok", canManage: true, applyableProposalTargets: ["directive","agent_setting","routine","agent_skill","context_variable","document","ingestion_settings","website_crawl"] } });
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
  await page.getByRole("textbox", { name: "Ask Ray" }).fill("Try this again");
  await page.getByRole("button", { name: "Send question" }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("The retry completed.")).toBeVisible();
  expect(turnCount).toBe(2);
});

test("reviews a directive proposal, expands its diff, applies it, and opens the target", async ({ page }) => {
  const copilotConversationId = "copilot-proposal-apply";
  const proposalId = "proposal-apply-1";
  const targetLabel = "Refund policy";
  const detail = {
    id: proposalId,
    targetType: "directive",
    targetLabel,
    summary: "Require approval before issuing a refund.",
    status: "pending",
    targetRef: { agentId: defaultAgentId, directiveId: "directive-refund-1" },
    preview: {
      current: { action: "Issue a refund", priority: 10 },
      proposed: { action: "Require approval before issuing a refund", priority: 20 },
    },
    currentVersionMatches: true,
    evidenceCases: null,
  };
  let messages: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability" && request.method() === "GET") return route.fulfill({ json: { available: true, reason: "ok", canManage: true, applyableProposalTargets: ["directive","agent_setting","routine","agent_skill","context_variable","document","ingestion_settings","website_crawl"] } });
    if (path === "/copilot/conversations" && request.method() === "GET") return route.fulfill({ json: { conversations: messages.length ? [{ id: copilotConversationId, title: "Draft a refund rule", status: "idle", createdAt: nowIso, updatedAt: nowIso }] : [] } });
    if (path === `/copilot/conversations/${copilotConversationId}` && request.method() === "GET") return route.fulfill({ json: { id: copilotConversationId, title: "Draft a refund rule", status: "idle", createdAt: nowIso, updatedAt: nowIso, messages } });
    if (path === `/copilot/proposals/${proposalId}` && request.method() === "GET") return route.fulfill({ json: detail });
    if (path === `/copilot/proposals/${proposalId}/apply` && request.method() === "POST") return route.fulfill({ json: { status: "applied", appliedRef: { directiveId: "directive-refund-1" } } });
    if (path === "/copilot/turns" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { message: string; pageContext: { view: string | null } };
      expect(body.pageContext).toEqual(expect.objectContaining({ view: "copilot" }));
      messages = [
        { id: "operator-proposal-apply", role: "operator", content: body.message, createdAt: nowIso },
        { id: "answer-proposal-apply", role: "copilot", content: "I drafted a refund directive for review.", createdAt: nowIso, outcome: "completed", activity: [], proposals: [{ id: proposalId, targetType: "directive", targetLabel, summary: detail.summary, status: "pending" }] },
      ];
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          `event: conversation\ndata: ${JSON.stringify({ conversationId: copilotConversationId, turnId: "turn-proposal-apply" })}`,
          `event: proposal\ndata: ${JSON.stringify({ proposalId, targetType: "directive", targetLabel, summary: detail.summary })}`,
          "event: chunk\ndata: {\"text\":\"I drafted a refund directive for review.\"}",
          "event: outcome\ndata: {\"status\":\"completed\"}",
          "event: done\ndata: {}",
        ].join("\n\n") + "\n\n",
      });
    }
    await route.continue();
  });

  await page.goto(`/w/${workspaceKey}/copilot`);
  await page.getByRole("textbox", { name: "Ask Ray" }).fill("Draft a refund rule");
  await page.getByRole("button", { name: "Send question" }).click();
  await expect(page.getByText(targetLabel, { exact: true })).toBeVisible();
  await expect(page.getByText(detail.summary, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Show proposed changes for ${targetLabel}`, exact: true }).click();
  await expect(page.getByText("Current", { exact: true })).toBeVisible();
  await expect(page.getByText("Require approval before issuing a refund", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("button", { name: "Apply proposal", exact: true }).click();
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Open ${targetLabel}`, exact: true })).toBeVisible();
});

test("reviews and applies a reversible directive disable proposal", async ({ page }) => {
  const copilotConversationId = "copilot-directive-disable-apply";
  const proposalId = "proposal-directive-disable-1";
  const targetLabel = "Avoid competitors";
  const summary = `Disable the directive "${targetLabel}". Its configured text will be preserved and it can be re-enabled later.`;
  const detail = {
    id: proposalId,
    targetType: "directive",
    targetLabel,
    summary,
    status: "pending",
    targetRef: { agentId: defaultAgentId, directiveId: "directive-competitors-1" },
    preview: {
      current: { name: targetLabel, enabled: true },
      proposed: { name: targetLabel, enabled: false },
    },
    currentVersionMatches: true,
    evidenceCases: null,
  };
  let messages: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability" && request.method() === "GET") return route.fulfill({ json: { available: true, reason: "ok", canManage: true, applyableProposalTargets: ["directive","agent_setting","routine","agent_skill","context_variable","document","ingestion_settings","website_crawl"] } });
    if (path === "/copilot/conversations" && request.method() === "GET") return route.fulfill({ json: { conversations: messages.length ? [{ id: copilotConversationId, title: "Disable a directive", status: "idle", createdAt: nowIso, updatedAt: nowIso }] : [] } });
    if (path === `/copilot/conversations/${copilotConversationId}` && request.method() === "GET") return route.fulfill({ json: { id: copilotConversationId, title: "Disable a directive", status: "idle", createdAt: nowIso, updatedAt: nowIso, messages } });
    if (path === `/copilot/proposals/${proposalId}` && request.method() === "GET") return route.fulfill({ json: detail });
    if (path === `/copilot/proposals/${proposalId}/apply` && request.method() === "POST") return route.fulfill({ json: { status: "applied", appliedRef: { directiveId: "directive-competitors-1" } } });
    if (path === "/copilot/turns" && request.method() === "POST") {
      messages = [
        { id: "operator-directive-disable", role: "operator", content: "Make this directive stop", createdAt: nowIso },
        { id: "answer-directive-disable", role: "copilot", content: "I drafted a reversible disable proposal for review.", createdAt: nowIso, outcome: "completed", activity: [], proposals: [{ id: proposalId, targetType: "directive", targetLabel, summary, status: "pending" }] },
      ];
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          `event: conversation\ndata: ${JSON.stringify({ conversationId: copilotConversationId, turnId: "turn-directive-disable" })}`,
          `event: proposal\ndata: ${JSON.stringify({ proposalId, targetType: "directive", targetLabel, summary })}`,
          "event: chunk\ndata: {\"text\":\"I drafted a reversible disable proposal for review.\"}",
          "event: outcome\ndata: {\"status\":\"completed\"}",
          "event: done\ndata: {}",
        ].join("\n\n") + "\n\n",
      });
    }
    await route.continue();
  });

  await page.goto(`/w/${workspaceKey}/copilot`);
  await page.getByRole("textbox", { name: "Ask Ray" }).fill("Make this directive stop");
  await page.getByRole("button", { name: "Send question" }).click();
  await page.getByRole("button", { name: `Show proposed changes for ${targetLabel}`, exact: true }).click();
  await expect(page.getByText("enabled", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("Apply this proposal?", { exact: true })).toBeVisible();
  await expect(page.getByText(`Delete ${targetLabel} permanently?`, { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "Apply proposal", exact: true }).click();
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
});

test("states plainly that applying a directive removal proposal deletes it permanently, without requiring the diff to be expanded first", async ({ page }) => {
  const copilotConversationId = "copilot-proposal-removal-apply";
  const proposalId = "proposal-removal-apply-1";
  const targetLabel = "Avoid competitors";
  const summary = `Permanently remove the directive "${targetLabel}". This cannot be undone.`;
  let messages: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability" && request.method() === "GET") return route.fulfill({ json: { available: true, reason: "ok", canManage: true, applyableProposalTargets: ["directive","agent_setting","routine","agent_skill","context_variable","document","ingestion_settings","website_crawl"] } });
    if (path === "/copilot/conversations" && request.method() === "GET") return route.fulfill({ json: { conversations: messages.length ? [{ id: copilotConversationId, title: "Remove the competitor directive", status: "idle", createdAt: nowIso, updatedAt: nowIso }] : [] } });
    if (path === `/copilot/conversations/${copilotConversationId}` && request.method() === "GET") return route.fulfill({ json: { id: copilotConversationId, title: "Remove the competitor directive", status: "idle", createdAt: nowIso, updatedAt: nowIso, messages } });
    if (path === `/copilot/proposals/${proposalId}/apply` && request.method() === "POST") return route.fulfill({ json: { status: "applied", appliedRef: { directiveId: "directive-competitors-1" } } });
    if (path === "/copilot/turns" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { message: string };
      messages = [
        { id: "operator-proposal-removal-apply", role: "operator", content: body.message, createdAt: nowIso },
        { id: "answer-proposal-removal-apply", role: "copilot", content: "I drafted a removal for review.", createdAt: nowIso, outcome: "completed", activity: [], proposals: [{ id: proposalId, targetType: "directive", targetLabel, summary, status: "pending", removal: true }] },
      ];
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          `event: conversation\ndata: ${JSON.stringify({ conversationId: copilotConversationId, turnId: "turn-proposal-removal-apply" })}`,
          `event: proposal\ndata: ${JSON.stringify({ proposalId, targetType: "directive", targetLabel, summary, removal: true })}`,
          "event: chunk\ndata: {\"text\":\"I drafted a removal for review.\"}",
          "event: outcome\ndata: {\"status\":\"completed\"}",
          "event: done\ndata: {}",
        ].join("\n\n") + "\n\n",
      });
    }
    await route.continue();
  });

  await page.goto(`/w/${workspaceKey}/copilot`);
  await page.getByRole("textbox", { name: "Ask Ray" }).fill("Remove the competitor directive");
  await page.getByRole("button", { name: "Send question" }).click();
  await expect(page.getByText(targetLabel, { exact: true })).toBeVisible();
  // Clicked directly, without ever expanding "Show changes" first - the exact gap Finding 1
  // (issue triage, next-ray-epic-issue) describes: an operator must see the deletion warning
  // from here, not only after expanding the diff.
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText(`Delete ${targetLabel} permanently?`, { exact: true })).toBeVisible();
  await expect(page.getByText(`This permanently deletes ${targetLabel}. This cannot be undone.`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply proposal", exact: true }).click();
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
});

test("offers Apply only on the proposals this operator may apply, and Dismiss on all of them", async ({ page }) => {
  // An operator who manages knowledge but not agents. Apply belongs on the document card and not on
  // the directive card; a single workspace-wide permission flag would have shown both or neither.
  const copilotConversationId = "copilot-proposal-mixed-permissions";

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability" && request.method() === "GET") {
      return route.fulfill({ json: { available: true, reason: "ok", canManage: false, applyableProposalTargets: ["document", "ingestion_settings", "website_crawl"] } });
    }
    if (path === "/copilot/conversations" && request.method() === "GET") return route.fulfill({ json: { conversations: [] } });
    if (path === "/copilot/turns" && request.method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          `event: conversation\ndata: ${JSON.stringify({ conversationId: copilotConversationId, turnId: "turn-mixed" })}`,
          `event: proposal\ndata: ${JSON.stringify({ proposalId: "proposal-doc-1", targetType: "document", targetLabel: "Refund policy", summary: "Add the document \"Refund policy\"." })}`,
          `event: proposal\ndata: ${JSON.stringify({ proposalId: "proposal-directive-1", targetType: "directive", targetLabel: "Avoid competitors", summary: "Draft a directive." })}`,
          "event: chunk\ndata: {\"text\":\"Two drafts.\"}",
          "event: outcome\ndata: {\"status\":\"completed\"}",
          "event: done\ndata: {}",
        ].join("\n\n") + "\n\n",
      });
    }
    await route.continue();
  });

  await page.goto(`/w/${workspaceKey}/copilot`);
  await page.getByRole("textbox", { name: "Ask Ray" }).fill("What should change?");
  await page.getByRole("button", { name: "Send question" }).click();

  const documentCard = page.locator("[data-slot=card]").filter({ hasText: "Refund policy" });
  const directiveCard = page.locator("[data-slot=card]").filter({ hasText: "Avoid competitors" });
  await expect(documentCard.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
  await expect(directiveCard.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
  await expect(documentCard.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
  await expect(directiveCard.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
});

test("applies a routine proposal and opens the routine editor", async ({ page }) => {
  const copilotConversationId = "copilot-routine-proposal-apply";
  const proposalId = "proposal-routine-apply-1";
  const routineId = "55555555-5555-4555-9555-000000000901";
  const targetLabel = "Refund workflow";
  const detail = {
    id: proposalId,
    targetType: "routine",
    targetLabel,
    summary: "Create a draft refund workflow.",
    status: "pending",
    targetRef: { agentId: defaultAgentId, routineId: null },
    preview: {
      current: null,
      proposed: { name: targetLabel, steps: [{ type: "message", text: "Review the refund request." }] },
    },
    currentVersionMatches: true,
    evidenceCases: null,
  };
  let messages: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routines: [{
      id: routineId,
      lineageId: routineId,
      status: "draft",
      version: 1,
      agentId: defaultAgentId,
      name: targetLabel,
      activation: { triggerDescription: "Customer asks for a refund.", gateRef: null, priority: 20, reentryMode: "once_per_conversation" },
      slots: [],
      steps: [{ stableStepId: "review_request", kind: "chat", instruction: "Review the refund request.", toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
      transitions: [{ fromStep: "review_request", toRef: "done", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
      terminals: [{ stableStepId: "done", kind: "complete", instruction: "All set.", ordinal: 0 }],
      createdAt: nowIso,
      updatedAt: nowIso,
    }],
  });
  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability" && request.method() === "GET") return route.fulfill({ json: { available: true, reason: "ok", canManage: true, applyableProposalTargets: ["directive","agent_setting","routine","agent_skill","context_variable","document","ingestion_settings","website_crawl"] } });
    if (path === "/copilot/conversations" && request.method() === "GET") return route.fulfill({ json: { conversations: messages.length ? [{ id: copilotConversationId, title: "Draft a refund workflow", status: "idle", createdAt: nowIso, updatedAt: nowIso }] : [] } });
    if (path === `/copilot/conversations/${copilotConversationId}` && request.method() === "GET") return route.fulfill({ json: { id: copilotConversationId, title: "Draft a refund workflow", status: "idle", createdAt: nowIso, updatedAt: nowIso, messages } });
    if (path === `/copilot/proposals/${proposalId}` && request.method() === "GET") return route.fulfill({ json: detail });
    if (path === `/copilot/proposals/${proposalId}/apply` && request.method() === "POST") return route.fulfill({ json: { status: "applied", appliedRef: { agentId: defaultAgentId, routineId } } });
    if (path === "/copilot/turns" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { message: string; pageContext: { view: string | null; agentId: string | null } };
      expect(body.pageContext).toEqual(expect.objectContaining({ view: "copilot", agentId: null }));
      messages = [
        { id: "operator-routine-proposal-apply", role: "operator", content: body.message, createdAt: nowIso },
        { id: "answer-routine-proposal-apply", role: "copilot", content: "I drafted a refund workflow for review.", createdAt: nowIso, outcome: "completed", activity: [], proposals: [{ id: proposalId, targetType: "routine", targetLabel, summary: detail.summary, status: "pending" }] },
      ];
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          `event: conversation\ndata: ${JSON.stringify({ conversationId: copilotConversationId, turnId: "turn-routine-proposal-apply" })}`,
          `event: proposal\ndata: ${JSON.stringify({ proposalId, targetType: "routine", targetLabel, summary: detail.summary })}`,
          "event: chunk\ndata: {\"text\":\"I drafted a refund workflow for review.\"}",
          "event: outcome\ndata: {\"status\":\"completed\"}",
          "event: done\ndata: {}",
        ].join("\n\n") + "\n\n",
      });
    }
    await route.continue();
  });

  // No ?agent= on purpose: the deep-link must work from the apply response's
  // appliedRef alone, without an agent-scoped page context.
  await page.goto(`/w/${workspaceKey}/copilot`);
  await page.getByRole("textbox", { name: "Ask Ray" }).fill("Draft a refund workflow");
  await page.getByRole("button", { name: "Send question" }).click();
  await expect(page.getByText(targetLabel, { exact: true })).toBeVisible();
  await expect(page.getByText(detail.summary, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("button", { name: "Apply proposal", exact: true }).click();
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Open ${targetLabel}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}/routines/${routineId}(\\?|$)`));
});

test("dismisses a pending proposal without applying it", async ({ page }) => {
  const copilotConversationId = "copilot-proposal-dismiss";
  const proposalId = "proposal-dismiss-1";
  let messages: unknown[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability" && request.method() === "GET") return route.fulfill({ json: { available: true, reason: "ok", canManage: true, applyableProposalTargets: ["directive","agent_setting","routine","agent_skill","context_variable","document","ingestion_settings","website_crawl"] } });
    if (path === "/copilot/conversations" && request.method() === "GET") return route.fulfill({ json: { conversations: messages.length ? [{ id: copilotConversationId, title: "Dismiss proposal", status: "idle", createdAt: nowIso, updatedAt: nowIso }] : [] } });
    if (path === `/copilot/conversations/${copilotConversationId}` && request.method() === "GET") return route.fulfill({ json: { id: copilotConversationId, title: "Dismiss proposal", status: "idle", createdAt: nowIso, updatedAt: nowIso, messages } });
    if (path === `/copilot/proposals/${proposalId}/dismiss` && request.method() === "POST") return route.fulfill({ json: { status: "dismissed" } });
    if (path === "/copilot/turns" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { message: string };
      messages = [{ id: "operator-proposal-dismiss", role: "operator", content: body.message, createdAt: nowIso }, { id: "answer-proposal-dismiss", role: "copilot", content: "Review this setting change.", createdAt: nowIso, outcome: "completed", activity: [], proposals: [{ id: proposalId, targetType: "agent_setting", targetLabel: "Answer style", summary: "Use a concise answer style.", status: "pending" }] }];
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: conversation\ndata: ${JSON.stringify({ conversationId: copilotConversationId, turnId: "turn-proposal-dismiss" })}\n\nevent: proposal\ndata: ${JSON.stringify({ proposalId, targetType: "agent_setting", targetLabel: "Answer style", summary: "Use a concise answer style." })}\n\nevent: chunk\ndata: {"text":"Review this setting change."}\n\nevent: outcome\ndata: {"status":"completed"}\n\nevent: done\ndata: {}\n\n` });
    }
    await route.continue();
  });
  await page.goto(`/w/${workspaceKey}/copilot`);
  await page.getByRole("textbox", { name: "Ask Ray" }).fill("Draft a concise style setting");
  await page.getByRole("button", { name: "Send question" }).click();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(page.getByText("Dismissed", { exact: true })).toBeVisible();
});

test("shows the stale explanation when applying a changed proposal", async ({ page }) => {
  const copilotConversationId = "copilot-proposal-stale";
  const proposalId = "proposal-stale-1";
  let messages: unknown[] = [];
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability" && request.method() === "GET") return route.fulfill({ json: { available: true, reason: "ok", canManage: true, applyableProposalTargets: ["directive","agent_setting","routine","agent_skill","context_variable","document","ingestion_settings","website_crawl"] } });
    if (path === "/copilot/conversations" && request.method() === "GET") return route.fulfill({ json: { conversations: messages.length ? [{ id: copilotConversationId, title: "Stale proposal", status: "idle", createdAt: nowIso, updatedAt: nowIso }] : [] } });
    if (path === `/copilot/conversations/${copilotConversationId}` && request.method() === "GET") return route.fulfill({ json: { id: copilotConversationId, title: "Stale proposal", status: "idle", createdAt: nowIso, updatedAt: nowIso, messages } });
    if (path === `/copilot/proposals/${proposalId}/apply` && request.method() === "POST") return route.fulfill({ json: { status: "stale" } });
    if (path === "/copilot/turns" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { message: string };
      messages = [{ id: "operator-proposal-stale", role: "operator", content: body.message, createdAt: nowIso }, { id: "answer-proposal-stale", role: "copilot", content: "This draft needs review.", createdAt: nowIso, outcome: "completed", activity: [], proposals: [{ id: proposalId, targetType: "directive", targetLabel: "Refund policy", summary: "Require approval for refunds.", status: "pending" }] }];
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: conversation\ndata: ${JSON.stringify({ conversationId: copilotConversationId, turnId: "turn-proposal-stale" })}\n\nevent: proposal\ndata: ${JSON.stringify({ proposalId, targetType: "directive", targetLabel: "Refund policy", summary: "Require approval for refunds." })}\n\nevent: chunk\ndata: {"text":"This draft needs review."}\n\nevent: outcome\ndata: {"status":"completed"}\n\nevent: done\ndata: {}\n\n` });
    }
    await route.continue();
  });
  await page.goto(`/w/${workspaceKey}/copilot`);
  await page.getByRole("textbox", { name: "Ask Ray" }).fill("Draft a refund approval rule");
  await page.getByRole("button", { name: "Send question" }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("button", { name: "Apply proposal", exact: true }).click();
  await expect(page.getByText("The target changed since this proposal was drafted. Ask Ray to draft it again.", { exact: true })).toBeVisible();
});

test("shows what a proposal was verified against, regressions and stale replays included", async ({ page }) => {
  const copilotConversationId = "copilot-proposal-evidence";
  const proposalId = "proposal-evidence-1";
  const targetLabel = "Refund window";
  const evidence = { total: 3, improved: 2, regressed: 1, unchanged: 0, stale: 1 };
  const detail = {
    id: proposalId,
    targetType: "directive",
    targetLabel,
    summary: "Always state the refund window.",
    status: "pending",
    targetRef: { agentId: defaultAgentId, directiveId: null },
    preview: { current: null, proposed: { action: "Always state the refund window" } },
    currentVersionMatches: true,
    evidence,
    evidenceCases: [
      { caseId: "case-1", caseName: "Refund window question", runId: "run-1", before: "failing", after: "pass", stale: false },
      { caseId: "case-2", caseName: "Late delivery", runId: "run-2", before: "failing", after: "pass", stale: true },
      { caseId: "case-3", caseName: "Shipping cost", runId: "run-3", before: "passing", after: "fail", stale: false },
    ],
  };
  let messages: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route("**/backend/api/v1/copilot/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (path === "/copilot/availability" && request.method() === "GET") return route.fulfill({ json: { available: true, reason: "ok", canManage: true, applyableProposalTargets: ["directive","agent_setting","routine","agent_skill","context_variable","document","ingestion_settings","website_crawl"] } });
    if (path === "/copilot/conversations" && request.method() === "GET") return route.fulfill({ json: { conversations: [] } });
    if (path === `/copilot/proposals/${proposalId}` && request.method() === "GET") return route.fulfill({ json: detail });
    if (path === "/copilot/turns" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as { message: string };
      messages = [
        { id: "operator-evidence", role: "operator", content: body.message, createdAt: nowIso },
        { id: "answer-evidence", role: "copilot", content: "I replayed three cases against the change.", createdAt: nowIso, outcome: "completed", activity: [], proposals: [{ id: proposalId, targetType: "directive", targetLabel, summary: detail.summary, status: "pending", evidence }] },
      ];
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          `event: conversation\ndata: ${JSON.stringify({ conversationId: copilotConversationId, turnId: "turn-evidence" })}`,
          `event: proposal\ndata: ${JSON.stringify({ proposalId, targetType: "directive", targetLabel, summary: detail.summary, evidence })}`,
          "event: chunk\ndata: {\"text\":\"I replayed three cases against the change.\"}",
          "event: outcome\ndata: {\"status\":\"completed\"}",
          "event: done\ndata: {}",
        ].join("\n\n") + "\n\n",
      });
    }
    if (path === `/copilot/conversations/${copilotConversationId}` && request.method() === "GET") return route.fulfill({ json: { id: copilotConversationId, title: "Refunds", status: "idle", createdAt: nowIso, updatedAt: nowIso, messages } });
    await route.continue();
  });

  await page.goto(`/w/${workspaceKey}/copilot`);
  await page.getByRole("textbox", { name: "Ask Ray" }).fill("Fix the refund answers");
  await page.getByRole("button", { name: "Send question" }).click();

  // The count the operator decides on is visible without expanding, and it names the regression.
  await expect(page.getByText("Verified against 3 cases — 2 improved, 1 regressed")).toBeVisible();
  await expect(page.getByText("measured a captured configuration the agent has changed since", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: `Show proposed changes for ${targetLabel}`, exact: true }).click();
  await expect(page.getByText("Refund window question", { exact: false })).toBeVisible();
  await expect(page.getByText("Shipping cost", { exact: false })).toBeVisible();
  await expect(page.getByText("agent changed since this case was captured", { exact: false })).toBeVisible();
});
