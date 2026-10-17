import { expect, test, type Page, type Route } from "@playwright/test";

import {
  currentUserId,
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

// A call speaks only when its caller does, so a teammate's reply waits for the caller's next turn.
// The backend of one voice conversation is stubbed at the network layer; the test plays the call,
// whose next turn speaks the reply, and the dashboard tail then returns the reply again, spoken.

type Speech = { state: "pending" } | { state: "spoken"; spokenAt: string };
type ThreadMessage = { id: string; role: "user" | "assistant"; source: string; content: string; createdAt: string; speech?: Speech };

const conversationId = "conversation-voice-handoff";
const replyText = "Yes, four works. Bring your card.";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const installCallBackend = async (page: Page) => {
  let ownership = {
    conversationId,
    workspaceId,
    state: "human_owned" as const,
    ownerAccountId: null as string | null,
    ownerUserId: null as string | null,
    ownerDisplayName: null as string | null,
    reason: "routine_handoff",
    version: 1,
    takenOverAt: null as string | null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const messages: ThreadMessage[] = [
    { id: "message-caller-1", role: "user", source: "customer", content: "Can I book a class at four?", createdAt: nowIso },
  ];
  const replies: Array<{ message: string; expectedVersion: number }> = [];
  // What the dashboard tail returns on its next poll: a reply marked since the pane read it.
  let redelivered: ThreadMessage[] = [];

  const summary = () => ({
    id: conversationId,
    agentId: defaultAgentId,
    agentName: "Gioia",
    sourceChannel: "voice",
    sourceOrigin: null,
    anonymousSessionId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: messages.length,
    userMessageCount: 1,
    assistantMessageCount: messages.length - 1,
    preview: "Can I book a class at four?",
    title: "Can I book a class at four?",
    ownership,
    channelContext: { provider: "voice", vendor: "elevenlabs", sessionKey: "session-call-1", transport: "web" },
  });

  await installDashboardApiMocks(page, {
    historyList: { conversations: [summary()], total: 1, nextCursor: null, hasMore: false },
  });
  await page.route("**/backend/api/v1/quality/turns**", (route) =>
    json(route, { items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 }));

  await page.route(`**/backend/api/v1/history/chat/${conversationId}**`, async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/tail")) {
      const tail = redelivered;
      redelivered = [];
      return json(route, { messages: tail, cursor: "tail-cursor", ownership, activity: [] });
    }
    return json(route, {
      ...summary(),
      conversationId,
      workspaceId,
      messagesTotal: messages.length,
      messageWindowOffset: 0,
      messageWindowLimit: 50,
      hasOlderMessages: false,
      nextCursor: null,
      messages,
    });
  });

  await page.route(`**/backend/api/v1/conversations/${conversationId}/**`, (route) => {
    const request = route.request();
    const action = new URL(request.url()).pathname.split("/").at(-1);
    if (request.method() === "POST" && action === "reply") {
      const body = request.postDataJSON() as { message: string; expectedVersion: number };
      replies.push(body);
      // A reply to a conversation nobody holds claims it in the same write.
      ownership = { ...ownership, ownerUserId: currentUserId, ownerDisplayName: "Test Operator", takenOverAt: nowIso, version: ownership.version + 1 };
      const message: ThreadMessage = {
        id: "message-teammate-reply",
        role: "assistant",
        source: "human_agent",
        content: body.message,
        createdAt: nowIso,
        speech: { state: "pending" },
      };
      messages.push(message);
      return json(route, { message: { ...message, conversationId, workspaceId }, ownership }, 201);
    }
    return json(route, { error: { code: "not_found", message: "Not stubbed" } }, 404);
  });

  return {
    replies,
    /** The caller speaks again: their turn speaks the pending reply, and only the tail says so. */
    callerSpeaks: () => {
      const reply = messages.find((message) => message.speech?.state === "pending");
      if (reply) redelivered = [{ ...reply, speech: { state: "spoken", spokenAt: nowIso } }];
    },
  };
};

test("a teammate's reply on a call is pending until the caller's next turn, then shows as spoken", async ({ page }) => {
  await seedDashboardStorage(page);
  const call = await installCallBackend(page);

  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByLabel("Inbox queue").getByRole("button", { name: /Can I book a class at four/ }).click();
  const response = page.getByLabel("Response", { exact: true });
  await expect(response.getByText("The caller hears this on their next turn.")).toBeVisible();

  await response.getByRole("textbox", { name: "Reply to the visitor" }).fill(replyText);
  await response.getByRole("button", { name: "Send" }).click();

  await expect(response.getByText(replyText)).toBeVisible();
  const pending = response.getByText("Pending", { exact: true });
  await expect(pending).toHaveCount(1);
  expect(call.replies).toEqual([{ message: replyText, expectedVersion: 1 }]);

  call.callerSpeaks();

  await expect(response.getByText("Spoken", { exact: true })).toHaveCount(1, { timeout: 15_000 });
  await expect(response.getByText("Pending", { exact: true })).toHaveCount(0);
  await expect(response.getByText(replyText)).toHaveCount(1);
});
