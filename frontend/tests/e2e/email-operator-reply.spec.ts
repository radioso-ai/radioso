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

// The backend of one email conversation is stubbed at the network layer: a reply queues a send,
// and the test plays the provider — accepting, delivering or bouncing it — the way `email:dev
// delivery` does against a real backend.

type DeliveryState = "queued" | "accepted" | "delivered" | "bounced" | "failed" | "uncertain" | "halted";
type SendingState = "ok" | "not_verified" | "domain_removed";

type DeliveryFailure = {
  id: string;
  conversationId: string;
  messageId: string | null;
  provider: string;
  kind: "bounced" | "failed" | "uncertain" | "halted";
  detailCode: string | null;
  openedAt: string;
  clearedAt: string | null;
  clearReason: string | null;
};

type ThreadMessage = { id: string; role: "user" | "assistant"; source: string; content: string; createdAt: string };

const conversationId = "conversation-email";
const mailboxId = "mailbox-support";
const replyMessageId = "message-reply-1";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const refuse = (route: Route, status: number, code: string, message: string) =>
  json(route, { error: { code, message } }, status);

const installEmailReplyBackend = async (
  page: Page,
  options: { sending: SendingState; refuseSends?: boolean; failedReply?: "uncertain" | "halted" },
) => {
  let sending = options.sending;
  let ownership = {
    conversationId,
    workspaceId,
    state: "human_owned" as const,
    ownerAccountId: null as string | null,
    ownerUserId: null as string | null,
    ownerDisplayName: null as string | null,
    reason: "operator_only_mailbox",
    version: 1,
    takenOverAt: null as string | null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const messages: ThreadMessage[] = [
    { id: "message-1", role: "user", source: "customer", content: "Order 4417 never arrived.", createdAt: nowIso },
  ];
  const deliveries = new Map<string, { state: DeliveryState; failureCode: string | null }>();
  const failures: DeliveryFailure[] = [];
  const replies: unknown[] = [];
  const acknowledged: string[] = [];
  const resolutions: Array<{ failureId: string; decision: string }> = [];
  // A reply already sent whose outcome is unknown, or that never went out, with its open failure.
  if (options.failedReply) {
    messages.push({ id: replyMessageId, role: "assistant", source: "human_agent", content: "We are tracking it now.", createdAt: nowIso });
    deliveries.set(replyMessageId, { state: options.failedReply, failureCode: null });
    failures.push({
      id: "failure-1",
      conversationId,
      messageId: replyMessageId,
      provider: "email",
      kind: options.failedReply,
      detailCode: null,
      openedAt: nowIso,
      clearedAt: null,
      clearReason: null,
    });
  }

  const summary = () => ({
    id: conversationId,
    agentId: defaultAgentId,
    agentName: "Gioia",
    sourceChannel: "email",
    sourceOrigin: null,
    anonymousSessionId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: messages.length,
    userMessageCount: 1,
    assistantMessageCount: messages.length - 1,
    preview: "Where is my order?",
    ownership,
    channelContext: {
      provider: "email",
      mailbox: { id: mailboxId, address: "support@customer.test" },
      threadKey: "8b3c1f4e-1d2a-4c5b-9e7f-0a1b2c3d4e5f",
      participant: { address: "ana@example.test" },
    },
  });

  const facts = () => ({
    mailbox: { id: mailboxId, address: "support@customer.test", displayName: "Support", engagementMode: "operator_only" },
    participant: { address: "ana@example.test", displayName: "Ana Pereira" },
    latest: { subject: "Where is my order?", cc: [], inboundAt: nowIso },
    sending: { state: sending },
    sendBudget: { used: 0, limit: 3, renewedAt: null },
    messages: messages.map((message) => ({
      messageId: message.id,
      direction: message.role === "user" ? "inbound" : "outbound",
      subject: "Where is my order?",
      cc: [],
      attachments: [],
      delivery: deliveries.get(message.id) ?? null,
      rawDeliveryId: null,
    })),
  });

  await installDashboardApiMocks(page, {
    historyList: { conversations: [summary()], total: 1, nextCursor: null, hasMore: false },
  });
  await page.route("**/backend/api/v1/quality/turns**", (route) =>
    json(route, { items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 }));

  await page.route(`**/backend/api/v1/history/chat/${conversationId}**`, (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/tail")) {
      return json(route, { messages: [], cursor: null, ownership, activity: [] });
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
    if (request.method() === "GET" && action === "email") return json(route, facts());
    if (request.method() === "POST" && action === "takeover") {
      ownership = {
        ...ownership,
        ownerAccountId: "account-1",
        ownerUserId: currentUserId,
        ownerDisplayName: "Test Operator",
        version: ownership.version + 1,
        takenOverAt: nowIso,
      };
      return json(route, { ownership });
    }
    if (request.method() === "POST" && action === "reply") {
      const body = request.postDataJSON() as { message: string; expectedVersion: number };
      replies.push(body);
      if (options.refuseSends) {
        return refuse(route, 409, "email_sending_not_verified", "The sending domain for support@customer.test is not verified.");
      }
      const message: ThreadMessage = {
        id: replyMessageId,
        role: "assistant",
        source: "human_agent",
        content: body.message,
        createdAt: nowIso,
      };
      messages.push(message);
      deliveries.set(message.id, { state: "queued", failureCode: null });
      return json(route, { message: { ...message, conversationId, workspaceId } }, 201);
    }
    return refuse(route, 404, "not_found", `Unhandled conversation route: ${request.method()} ${action}`);
  });

  await page.route("**/backend/api/v1/delivery-failures**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/backend/api/v1", "");
    if (request.method() === "GET" && path === "/delivery-failures") {
      return json(route, { items: failures.filter((failure) => failure.clearedAt === null), nextCursor: null });
    }
    const decision = path.match(/^\/delivery-failures\/([^/]+)\/(acknowledge|resolve)$/);
    const failure = decision ? failures.find((candidate) => candidate.id === decision[1]) : undefined;
    if (request.method() === "POST" && failure && decision?.[2] === "acknowledge") {
      acknowledged.push(failure.id);
      failure.clearedAt = nowIso;
      failure.clearReason = "acknowledged";
      return json(route, failure);
    }
    if (request.method() === "POST" && failure && decision?.[2] === "resolve") {
      const body = request.postDataJSON() as { decision: "marked_sent" | "resend" };
      if (body.decision === "resend" && sending !== "ok") {
        return refuse(route, 409, "email_sending_not_verified", "The sending domain for support@customer.test is not verified.");
      }
      resolutions.push({ failureId: failure.id, decision: body.decision });
      deliveries.set(replyMessageId, { state: body.decision === "resend" ? "queued" : "delivered", failureCode: null });
      failure.clearedAt = nowIso;
      failure.clearReason = "operator_resolved";
      return json(route, failure);
    }
    return refuse(route, 404, "not_found", `Unhandled delivery failure route: ${request.method()} ${path}`);
  });

  return {
    replies,
    acknowledged,
    resolutions,
    setSending: (next: SendingState) => { sending = next; },
    /** The provider reports where the reply stands; a bounce raises a failure with its sanitized code. */
    settle: (state: DeliveryState, failureCode: string | null = null) => {
      deliveries.set(replyMessageId, { state, failureCode });
      if (state === "bounced") {
        failures.push({
          id: "failure-1",
          conversationId,
          messageId: replyMessageId,
          provider: "email",
          kind: "bounced",
          detailCode: failureCode,
          openedAt: nowIso,
          clearedAt: null,
          clearReason: null,
        });
      }
    },
  };
};

const openEmailConversation = async (page: Page) => {
  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByLabel("Inbox queue").getByRole("button", { name: /Handoff.*Where is my order/ }).click();
  return page.getByLabel("Response", { exact: true });
};

const openDeliveryFailure = async (page: Page) => {
  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByLabel("Inbox queue").getByRole("button", { name: /Delivery failure.*Where is my order/ }).click();
  const response = page.getByLabel("Response", { exact: true });
  return { response, panel: response.getByRole("region", { name: "Delivery failure" }) };
};

// Facts are polled every few seconds while a reply is on its way.
const factsPoll = { timeout: 15_000 };

test("an operator's reply is queued, then delivered, and the header says so", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installEmailReplyBackend(page, { sending: "ok" });

  const response = await openEmailConversation(page);
  const header = response.getByRole("region", { name: "Email", exact: true });
  await expect(header.getByText("Ana Pereira <ana@example.test>")).toBeVisible();

  await response.getByRole("textbox", { name: "Reply to the visitor" }).fill("We are tracking it now.");
  await response.getByRole("button", { name: "Send" }).click();

  const delivery = header.getByRole("list", { name: "Reply delivery" }).getByRole("listitem");
  await expect(delivery).toHaveCount(1);
  await expect(delivery).toContainText("We are tracking it now.");
  await expect(delivery).toContainText("Queued");
  expect(backend.replies).toEqual([{ message: "We are tracking it now.", expectedVersion: 2 }]);

  backend.settle("accepted");
  await expect(delivery).toContainText("Sent", factsPoll);
  backend.settle("delivered");
  await expect(delivery).toContainText("Delivered", factsPoll);
});

test("a reply refused because the domain is unverified keeps the draft and focus and shows the server's reason", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installEmailReplyBackend(page, { sending: "ok", refuseSends: true });

  const response = await openEmailConversation(page);
  const replyBox = response.getByRole("textbox", { name: "Reply to the visitor" });
  await replyBox.fill("We are tracking it now.");
  await response.getByRole("button", { name: "Send" }).click();

  await expect(response.getByText("The sending domain for support@customer.test is not verified.")).toBeVisible();
  await expect(response.getByRole("button", { name: "Send" })).toBeDisabled();
  await expect(replyBox).toHaveValue("We are tracking it now.");
  await expect(replyBox).toBeFocused();
  expect(backend.replies).toHaveLength(1);
});

test("the composer waits for a verified domain, then sends", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installEmailReplyBackend(page, { sending: "not_verified" });

  const response = await openEmailConversation(page);
  await response.getByRole("textbox", { name: "Reply to the visitor" }).fill("We are tracking it now.");
  await expect(response.getByText("Replies wait until this mailbox’s domain is verified.")).toBeVisible();
  const send = response.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();

  backend.setSending("ok");
  await expect(send).toBeEnabled(factsPoll);
  await expect(response.getByText("Replies wait until this mailbox’s domain is verified.")).toHaveCount(0);
  await send.click();
  await expect(response.getByRole("list", { name: "Reply delivery" })).toContainText("Queued");
  expect(backend.replies).toHaveLength(1);
});

test("a bounced reply becomes a delivery failure with its code, and acknowledging it clears it from the Inbox", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installEmailReplyBackend(page, { sending: "ok" });

  const response = await openEmailConversation(page);
  await response.getByRole("textbox", { name: "Reply to the visitor" }).fill("We are tracking it now.");
  await response.getByRole("button", { name: "Send" }).click();
  const delivery = response.getByRole("list", { name: "Reply delivery" });
  await expect(delivery).toContainText("Queued");

  backend.settle("bounced", "mailbox_full");
  await expect(delivery).toContainText("Bounced · mailbox_full", factsPoll);

  // The failure reaches the Inbox on its next read; a reload reads it now.
  await page.reload();
  const queue = page.getByLabel("Inbox queue");
  const failureRow = queue.getByRole("button", { name: /Delivery failure.*Where is my order/ });
  await expect(failureRow).toBeVisible();
  await expect(page.getByText("Needs you · 2")).toBeVisible();

  await failureRow.click();
  const panel = page.getByLabel("Response", { exact: true }).getByRole("region", { name: "Delivery failure" });
  await expect(panel.getByText("Bounced · mailbox_full")).toBeVisible();
  await panel.getByRole("button", { name: "Acknowledge" }).click();

  await expect(failureRow).toHaveCount(0);
  await expect(page.getByText("Needs you · 1")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Delivery failure acknowledged." })).toHaveCount(1);
  expect(backend.acknowledged).toEqual(["failure-1"]);
});

test("an unconfirmed send is marked sent after one confirmation, and its row clears", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installEmailReplyBackend(page, { sending: "ok", failedReply: "uncertain" });

  const { response, panel } = await openDeliveryFailure(page);
  await expect(panel.getByText("Unconfirmed", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Mark sent" }).click();

  const confirmation = panel.getByRole("group", { name: "Confirm Mark sent" });
  await expect(confirmation.getByText("Marks this reply as delivered without sending it.")).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Confirm" })).toBeFocused();
  expect(backend.resolutions).toEqual([]);
  await confirmation.getByRole("button", { name: "Confirm" }).click();

  await expect(panel.getByRole("status")).toHaveText("Marked sent.");
  await expect(panel).toBeFocused();
  await expect(page.getByLabel("Inbox queue").getByRole("button", { name: /Delivery failure/ })).toHaveCount(0);
  await expect(response.getByRole("list", { name: "Reply delivery" })).toContainText("Delivered");
  expect(backend.resolutions).toEqual([{ failureId: "failure-1", decision: "marked_sent" }]);
});

test("a halted reply cannot be resent while the mailbox cannot send, and says why", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installEmailReplyBackend(page, { sending: "not_verified", failedReply: "halted" });

  const { panel } = await openDeliveryFailure(page);
  await expect(panel.getByText("Not sent", { exact: true })).toBeVisible();
  const resend = panel.getByRole("button", { name: "Resend" });
  await expect(resend).toBeDisabled();
  await expect(resend).toHaveAccessibleDescription("Replies wait until this mailbox’s domain is verified.");
  await expect(panel.getByRole("button", { name: "Mark sent" })).toBeDisabled();
  await expect(panel.getByText("Only an unconfirmed send can be marked sent.")).toBeVisible();
  expect(backend.resolutions).toEqual([]);
});

test("a halted reply is resent after one confirmation, and its delivery shows queued", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installEmailReplyBackend(page, { sending: "ok", failedReply: "halted" });

  const { response, panel } = await openDeliveryFailure(page);
  const delivery = response.getByRole("list", { name: "Reply delivery" });
  await expect(delivery).toContainText("Not sent");
  await panel.getByRole("button", { name: "Resend" }).click();

  const confirmation = panel.getByRole("group", { name: "Confirm Resend" });
  await expect(confirmation.getByText("Sends this reply again; the customer may receive it twice.")).toBeVisible();
  await confirmation.getByRole("button", { name: "Confirm" }).click();

  await expect(panel.getByRole("status")).toHaveText("Queued to send again.");
  await expect(panel).toBeFocused();
  await expect(delivery).toContainText("Queued");
  await expect(page.getByLabel("Inbox queue").getByRole("button", { name: /Delivery failure/ })).toHaveCount(0);
  expect(backend.resolutions).toEqual([{ failureId: "failure-1", decision: "resend" }]);
});
