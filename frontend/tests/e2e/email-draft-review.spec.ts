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

// The backend of one email conversation on a `draft` mailbox is stubbed at the network layer: an
// inbound produced a review turn whose reply is held for an operator. The test plays the customer
// (a newer inbound) and a teammate (a release that wins the race).

type HeldReplyState = "pending" | "queued_auto" | "released" | "edited" | "discarded" | "superseded";

type HeldReply = {
  id: string;
  conversationId: string;
  agentId: string | null;
  state: HeldReplyState;
  holdReason: string;
  facts: {
    grounding: string;
    coverage: string;
    handoff: { requested: boolean; reason: string | null };
    outcome: string;
  };
  dependsOnSuppressedAction: boolean;
  suppressedEffects: { skillName: string }[];
  draftText: string;
  editedText: string | null;
  createdAt: string;
  decidedAt: string | null;
  releaserUserId: string | null;
  editorUserId: string | null;
  attentionOpen: boolean;
  trace: {
    turnId: string;
    outcome: string | null;
    groundingVerdict: "grounded" | "degraded" | "no_support" | null;
    coverage: string;
    handoffReason: string | null;
    suppressedEffects: { skillName: string }[];
  } | null;
};

type ThreadMessage = { id: string; role: "user" | "assistant"; source: string; content: string; createdAt: string };

const conversationId = "conversation-email-draft";
const mailboxId = "mailbox-support";
const draftText = "We have refunded order 4417. You will see it in 3 to 5 days.";
const newerDraftText = "Thanks for the photo. Order 4417 is on its way back to us.";
const teammateUserId = "user-2";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const refuse = (route: Route, status: number, code: string, message: string, details?: unknown) =>
  json(route, { error: { code, message, ...(details === undefined ? {} : { details }) } }, status);

const reviewTurnId = "7d0c5a51-3f7e-4b9a-9c1e-2a4f6b8d0e13";

// The review turn's reasoning as the held-reply contract carries it: codes and the turn's id.
const reviewTrace: HeldReply["trace"] = {
  turnId: reviewTurnId,
  outcome: "coverage_partial",
  groundingVerdict: "grounded",
  coverage: "partial",
  handoffReason: null,
  suppressedEffects: [{ skillName: "refund_order" }],
};

const heldReply = (overrides: Partial<HeldReply> = {}): HeldReply => ({
  id: "held-1",
  conversationId,
  agentId: defaultAgentId,
  state: "pending",
  holdReason: "draft_mode",
  facts: {
    grounding: "grounded",
    coverage: "partial",
    handoff: { requested: false, reason: null },
    outcome: "answered",
  },
  // The turn needed a refund it was not allowed to run: the draft depends on it.
  dependsOnSuppressedAction: true,
  suppressedEffects: [{ skillName: "refund_order" }],
  draftText,
  editedText: null,
  createdAt: nowIso,
  decidedAt: null,
  releaserUserId: null,
  editorUserId: null,
  attentionOpen: true,
  trace: reviewTrace,
  ...overrides,
});

const installDraftReviewBackend = async (
  page: Page,
  options: {
    teammateReleasesFirst?: boolean;
    refuseRelease?: "policy_changed" | "channel_not_ready" | "email_sending_not_verified";
    /** The mailbox refuses an operator's reply before anything is written. */
    refuseReplies?: boolean;
    /** The held reply the review produced, where it differs from the default draft. */
    heldReply?: Partial<HeldReply>;
  } = {},
) => {
  let ownership = {
    conversationId,
    workspaceId,
    state: "ai_owned" as "ai_owned" | "human_owned",
    ownerAccountId: null as string | null,
    ownerUserId: null as string | null,
    ownerDisplayName: null as string | null,
    reason: null as string | null,
    version: 1,
    takenOverAt: null as string | null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const messages: ThreadMessage[] = [
    { id: "message-1", role: "user", source: "customer", content: "Order 4417 arrived broken. Please refund it.", createdAt: nowIso },
  ];
  const heldReplies: HeldReply[] = [heldReply(options.heldReply)];
  const releases: Array<{ heldReplyId: string; body: Record<string, unknown> }> = [];
  const discards: string[] = [];
  const replies: unknown[] = [];
  const takeovers: unknown[] = [];

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
    userMessageCount: messages.filter((message) => message.role === "user").length,
    assistantMessageCount: messages.filter((message) => message.role === "assistant").length,
    preview: "My order arrived broken",
    ownership,
    channelContext: {
      provider: "email",
      mailbox: { id: mailboxId, address: "support@customer.test" },
      threadKey: "8b3c1f4e-1d2a-4c5b-9e7f-0a1b2c3d4e5f",
      participant: { address: "ana@example.test" },
    },
  });

  const facts = () => ({
    mailbox: { id: mailboxId, address: "support@customer.test", displayName: "Support", engagementMode: "draft" },
    participant: { address: "ana@example.test", displayName: "Ana Pereira" },
    latest: { subject: "My order arrived broken", cc: [], inboundAt: nowIso },
    sending: { state: "ok" },
    sendBudget: { used: 0, limit: 3, renewedAt: null },
    messages: messages.map((message) => ({
      messageId: message.id,
      direction: message.role === "user" ? "inbound" : "outbound",
      subject: "My order arrived broken",
      cc: [],
      attachments: [],
      delivery: message.role === "user" ? null : { state: "queued", failureCode: null },
      rawDeliveryId: null,
    })),
  });

  // The conversation's newest held reply, whatever its state.
  const current = () => heldReplies.at(-1) ?? null;

  const clearAttention = () => {
    heldReplies.forEach((reply) => {
      if (reply.state === "pending") reply.state = "superseded";
      reply.attentionOpen = false;
    });
  };

  await installDashboardApiMocks(page, {
    historyList: { conversations: [summary()], total: 1, nextCursor: null, hasMore: false },
  });
  await page.route("**/backend/api/v1/quality/turns**", (route) =>
    json(route, { items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 }));
  await page.route("**/backend/api/v1/delivery-failures**", (route) => json(route, { items: [], nextCursor: null }));

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

  await page.route("**/backend/api/v1/held-replies**", (route) => {
    const url = new URL(route.request().url());
    const attention = url.searchParams.get("attention") ?? "open";
    const items = heldReplies.filter((reply) => attention === "all" || reply.attentionOpen);
    return json(route, { items, nextCursor: null });
  });

  await page.route(`**/backend/api/v1/conversations/${conversationId}/**`, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(`/backend/api/v1/conversations/${conversationId}`, "");
    if (request.method() === "GET" && path === "/email") return json(route, facts());
    if (request.method() === "GET" && path === "/held-reply") return json(route, { heldReply: current() });

    const decision = path.match(/^\/held-replies\/([^/]+)\/(release|discard)$/);
    const target = decision ? heldReplies.find((reply) => reply.id === decision[1]) : undefined;
    if (request.method() === "POST" && decision && !target) return refuse(route, 404, "not_found", "Held reply not found");
    if (request.method() === "POST" && target && decision?.[2] === "release") {
      const body = (request.postDataJSON() ?? {}) as { editedText?: string };
      if (options.teammateReleasesFirst && target.state === "pending") {
        // A teammate's release committed a moment before this one.
        Object.assign(target, { state: "released", decidedAt: nowIso, releaserUserId: teammateUserId, attentionOpen: false });
      }
      if (target.state !== "pending") {
        return refuse(route, 409, "held_reply_not_pending", "This held reply is no longer pending.", { heldReply: target });
      }
      if (options.refuseRelease === "email_sending_not_verified") {
        // The channel's own refusal, as the operator reply gets it: it names the missing step.
        return refuse(route, 409, options.refuseRelease, "Refused.", { step: "verify_sending_domain", domain: "customer.test" });
      }
      if (options.refuseRelease) {
        return refuse(route, 409, options.refuseRelease, "Refused.", { heldReply: target });
      }
      releases.push({ heldReplyId: target.id, body });
      const edited = typeof body.editedText === "string";
      Object.assign(target, {
        state: edited ? "edited" : "released",
        editedText: edited ? body.editedText : null,
        editorUserId: edited ? currentUserId : null,
        releaserUserId: currentUserId,
        decidedAt: nowIso,
        attentionOpen: false,
      });
      const message: ThreadMessage = {
        id: `message-release-${releases.length}`,
        role: "assistant",
        source: edited ? "human_agent" : "assistant",
        content: edited ? (body.editedText ?? "") : target.draftText,
        createdAt: nowIso,
      };
      messages.push(message);
      return json(route, { heldReply: target, messageId: message.id, delivery: "queued" }, 201);
    }
    if (request.method() === "POST" && target && decision?.[2] === "discard") {
      if (target.state !== "pending") {
        return refuse(route, 409, "held_reply_not_pending", "This held reply is no longer pending.", { heldReply: target });
      }
      discards.push(target.id);
      // Discarding keeps the conversation flagged until an operator replies or takes it over.
      Object.assign(target, { state: "discarded", decidedAt: nowIso });
      return json(route, target);
    }
    if (request.method() === "POST" && path === "/takeover") {
      takeovers.push(request.postDataJSON());
      ownership = {
        ...ownership,
        state: "human_owned",
        ownerAccountId: "account-1",
        ownerUserId: currentUserId,
        ownerDisplayName: "Test Operator",
        reason: "operator_takeover",
        version: ownership.version + 1,
        takenOverAt: nowIso,
      };
      clearAttention();
      return json(route, { ownership });
    }
    if (request.method() === "POST" && path === "/reply") {
      const body = request.postDataJSON() as { message: string; expectedVersion: number };
      replies.push(body);
      // The mailbox's refusal comes before any write: the draft stays pending and the agent keeps
      // the conversation.
      if (options.refuseReplies) {
        return refuse(route, 409, "email_sending_not_verified", "Replies to this email conversation can be sent once its sending domain is verified.", {
          step: "verify_sending_domain",
        });
      }
      if (body.expectedVersion !== ownership.version) {
        return refuse(route, 409, "conflict", "Conversation ownership changed");
      }
      // A reply claims the conversation and supersedes its draft in the same write.
      ownership = {
        ...ownership,
        state: "human_owned",
        ownerAccountId: "account-1",
        ownerUserId: currentUserId,
        ownerDisplayName: "Test Operator",
        reason: "operator_takeover",
        version: ownership.version + 1,
        takenOverAt: nowIso,
      };
      clearAttention();
      const message: ThreadMessage = { id: "message-operator-1", role: "assistant", source: "human_agent", content: body.message, createdAt: nowIso };
      messages.push(message);
      return json(route, { message: { ...message, conversationId, workspaceId } }, 201);
    }
    return refuse(route, 404, "not_found", `Unhandled conversation route: ${request.method()} ${path}`);
  });

  return {
    releases,
    discards,
    replies,
    takeovers,
    ownershipState: () => ownership.state,
    heldReplyStates: () => heldReplies.map((reply) => reply.state),
    /** The customer writes again before review: the pending draft is superseded by a fresh one. */
    receiveNewerInbound: () => {
      heldReplies.forEach((reply) => {
        if (reply.state === "pending") Object.assign(reply, { state: "superseded", attentionOpen: false });
      });
      messages.push({ id: "message-2", role: "user", source: "customer", content: "Here is a photo of the damage.", createdAt: nowIso });
      heldReplies.push(heldReply({
        id: "held-2",
        draftText: newerDraftText,
        dependsOnSuppressedAction: false,
        suppressedEffects: [],
        facts: { grounding: "grounded", coverage: "answered", handoff: { requested: false, reason: null }, outcome: "answered" },
      }));
    },
  };
};

const openDraft = async (page: Page) => {
  await page.goto(`/w/${workspaceKey}/activity`);
  // An AI-owned conversation has no summary in the Inbox's lists, so its row is titled by the draft.
  const row = page.getByLabel("Inbox queue").getByRole("button", { name: /Approval.*We have refunded order 4417/ });
  await row.click();
  const response = page.getByLabel("Response", { exact: true });
  return { row, response, panel: response.getByRole("region", { name: "Draft reply" }) };
};

// The open conversation's draft is read again every few seconds.
const draftPoll = { timeout: 15_000 };

test("a draft mailbox's inbound becomes an approval whose panel shows the outcome, the reasoning, and the action that did not run", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDraftReviewBackend(page);

  const { row, panel } = await openDraft(page);
  await expect(row).toBeVisible();
  await expect(page.getByText("Needs you · 1")).toBeVisible();

  await expect(panel.getByText("Answered", { exact: true })).toBeVisible();
  await expect(panel.getByText("Grounded · Partly answered")).toBeVisible();
  await expect(panel.getByText("Depends on an action that did not run")).toBeVisible();
  await expect(panel.getByText("Not run: refund_order")).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Draft reply text" })).toHaveValue(draftText);

  await panel.getByRole("button", { name: "Reasoning" }).click();
  await expect(panel.getByRole("list", { name: "Reasoning" }).getByRole("listitem")).toHaveText([
    "Outcome: Coverage partial",
    "Grounding: Grounded",
    "Coverage: Partly answered",
    "Not run: refund_order",
    `Turn: ${reviewTurnId}`,
  ]);
});

test("a grounded draft held for the send budget says why, though the turn's reasoning is unreadable", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDraftReviewBackend(page, {
    heldReply: {
      holdReason: "send_budget",
      facts: { grounding: "grounded", coverage: "answered", handoff: { requested: false, reason: null }, outcome: "answered" },
      dependsOnSuppressedAction: false,
      suppressedEffects: [],
      trace: null,
    },
  });

  const { panel } = await openDraft(page);
  await expect(panel.getByText("Grounded · Fully answered")).toBeVisible();
  await expect(panel.getByText("Held: this thread’s automatic replies are used up")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Reasoning" })).toHaveCount(0);
});

test("sending the draft unchanged releases it as written, keeps focus, and announces it", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installDraftReviewBackend(page);

  const { row, panel } = await openDraft(page);
  await panel.getByRole("button", { name: "Send draft" }).click();

  await expect(panel.getByRole("status").filter({ hasText: "Sent." })).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(row).toHaveCount(0);
  await expect(panel.getByRole("textbox", { name: "Draft reply text" })).toHaveCount(0);
  await expect(panel.getByText(draftText)).toBeVisible();
  expect(backend.releases).toEqual([{ heldReplyId: "held-1", body: {} }]);
});

test("sending an edited draft sends the edit and keeps the original on show", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installDraftReviewBackend(page);

  const { panel } = await openDraft(page);
  const editor = panel.getByRole("textbox", { name: "Draft reply text" });
  await editor.fill("We are refunding order 4417 now. Expect it in 3 to 5 days.");
  await expect(panel.getByRole("button", { name: "Send draft" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Send edited" }).click();

  await expect(panel.getByRole("status").filter({ hasText: "Sent your edit." })).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(panel.getByText("We are refunding order 4417 now. Expect it in 3 to 5 days.")).toBeVisible();
  const original = panel.getByRole("group", { name: "Original draft" });
  await expect(original).toContainText(draftText);
  expect(backend.releases).toEqual([
    { heldReplyId: "held-1", body: { editedText: "We are refunding order 4417 now. Expect it in 3 to 5 days." } },
  ]);
});

test("discarding asks once, keeps the item in the Inbox, and a reply then clears it", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installDraftReviewBackend(page);

  const { row, response, panel } = await openDraft(page);
  await panel.getByRole("button", { name: "Discard" }).click();
  const confirmation = panel.getByRole("group", { name: "Confirm Discard" });
  await expect(confirmation.getByText("Nothing is sent. The conversation stays in your Inbox until someone replies.")).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Confirm" })).toBeFocused();
  expect(backend.discards).toEqual([]);
  await confirmation.getByRole("button", { name: "Confirm" }).click();

  await expect(panel.getByRole("status").filter({ hasText: "Discarded. It stays in your Inbox until someone replies." })).toBeVisible();
  await expect(panel).toBeFocused();
  expect(backend.discards).toEqual(["held-1"]);
  await page.reload();
  await expect(row).toBeVisible();

  await row.click();
  await response.getByRole("textbox", { name: "Reply to the visitor" }).fill("A teammate will call you today.");
  await response.getByRole("button", { name: "Send", exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(backend.releases).toEqual([]);
  expect(backend.replies).toHaveLength(1);
});

test("a reply the mailbox refuses leaves the draft pending and the conversation with the agent", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installDraftReviewBackend(page, { refuseReplies: true });

  const { row, response, panel } = await openDraft(page);
  const replyBox = response.getByRole("textbox", { name: "Reply to the visitor" });
  await replyBox.fill("A teammate will call you today.");
  await response.getByRole("button", { name: "Send", exact: true }).click();

  await expect(response.getByText("Replies to this email conversation can be sent once its sending domain is verified.")).toBeVisible();
  await expect(replyBox).toHaveValue("A teammate will call you today.");
  await expect(row).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Draft reply text" })).toHaveValue(draftText);
  expect(backend.replies).toEqual([{ message: "A teammate will call you today.", expectedVersion: 1 }]);
  // Nothing claimed the conversation before the refusal, so nothing superseded the draft.
  expect(backend.takeovers).toEqual([]);
  expect(backend.ownershipState()).toBe("ai_owned");
  expect(backend.heldReplyStates()).toEqual(["pending"]);
});

test("every waiting draft and delivery failure reaches the Inbox, past the first page of fifty", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route("**/backend/api/v1/quality/turns**", (route) =>
    json(route, { items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 }));

  // Both lists answer newest first, fifty to a page; the oldest of each sits on the second page.
  const minutesAgo = (minutes: number) => new Date(Date.parse(nowIso) - minutes * 60_000).toISOString();
  const drafts = Array.from({ length: 51 }, (_, index) => heldReply({
    id: `held-${index}`,
    conversationId: `conversation-draft-${index}`,
    draftText: index === 50 ? "The oldest draft waits on the second page." : `Draft number ${index}.`,
    createdAt: minutesAgo(index + 1),
  }));
  await page.route("**/backend/api/v1/held-replies**", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    return cursor === "held-page-2"
      ? json(route, { items: drafts.slice(50), nextCursor: null })
      : json(route, { items: drafts.slice(0, 50), nextCursor: "held-page-2" });
  });
  const failure = (id: string, openedAt: string) => ({
    id,
    conversationId: `conversation-${id}`,
    messageId: `message-${id}`,
    provider: "email",
    kind: "bounced",
    detailCode: "mailbox_full",
    openedAt,
    clearedAt: null,
    clearReason: null,
  });
  await page.route("**/backend/api/v1/delivery-failures**", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    return cursor === "failure-page-2"
      ? json(route, { items: [failure("failure-oldest", minutesAgo(600))], nextCursor: null })
      : json(route, { items: [failure("failure-newest", minutesAgo(1))], nextCursor: "failure-page-2" });
  });

  await page.goto(`/w/${workspaceKey}/activity`);
  const queue = page.getByLabel("Inbox queue");
  await expect(page.getByText("Needs you · 53")).toBeVisible();
  await expect(queue.getByRole("button", { name: /Approval.*The oldest draft waits on the second page/ })).toBeVisible();
  await expect(queue.getByRole("button", { name: /Delivery failure/ })).toHaveCount(2);
  // Everything waiting was read, so nothing says some is missing.
  await expect(page.getByText("Older drafts or delivery failures are waiting beyond what the Inbox shows.")).toHaveCount(0);
});

test("past the Inbox's read limit, Load older reads on until the oldest draft and delivery failure show", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  await page.route("**/backend/api/v1/quality/turns**", (route) =>
    json(route, { items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 }));

  // One item to a page: the twenty pages one read follows stop an item short of the oldest of each.
  const minutesAgo = (minutes: number) => new Date(Date.parse(nowIso) - minutes * 60_000).toISOString();
  const drafts = Array.from({ length: 21 }, (_, index) => heldReply({
    id: `held-${index}`,
    conversationId: `conversation-draft-${index}`,
    draftText: index === 20 ? "The oldest draft waits past the read limit." : `Draft number ${index}.`,
    createdAt: minutesAgo(index + 1),
  }));
  const failures = Array.from({ length: 21 }, (_, index) => ({
    id: `failure-${index}`,
    conversationId: `conversation-failure-${index}`,
    messageId: `message-failure-${index}`,
    provider: "email",
    kind: "bounced",
    detailCode: "mailbox_full",
    openedAt: minutesAgo(index + 1),
    clearedAt: null,
    clearReason: null,
  }));
  const pageAt = <T>(items: T[], route: Route) => {
    const index = Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0);
    return json(route, { items: [items[index]], nextCursor: index < items.length - 1 ? String(index + 1) : null });
  };
  await page.route("**/backend/api/v1/held-replies**", (route) => pageAt(drafts, route));
  await page.route("**/backend/api/v1/delivery-failures**", (route) => pageAt(failures, route));

  await page.goto(`/w/${workspaceKey}/activity`);
  const queue = page.getByLabel("Inbox queue");
  const oldestDraft = queue.getByRole("button", { name: /Approval.*The oldest draft waits past the read limit/ });
  const failureRows = queue.getByRole("button", { name: /Delivery failure/ });
  const notice = page.getByText("Older drafts or delivery failures are waiting beyond what the Inbox shows.");
  await expect(page.getByText("Needs you · 40")).toBeVisible();
  await expect(notice).toBeVisible();
  await expect(oldestDraft).toHaveCount(0);
  await expect(failureRows).toHaveCount(20);

  await page.getByRole("button", { name: "Load older" }).click();
  await expect(page.getByText("Needs you · 42")).toBeVisible();
  await expect(oldestDraft).toBeVisible();
  await expect(failureRows).toHaveCount(21);
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load older" })).toHaveCount(0);
});

test("a newer inbound replaces the draft in place, and Send releases the newer one", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installDraftReviewBackend(page);

  const { panel } = await openDraft(page);
  const editor = panel.getByRole("textbox", { name: "Draft reply text" });
  await expect(editor).toHaveValue(draftText);

  backend.receiveNewerInbound();
  await expect(editor).toHaveValue(newerDraftText, draftPoll);
  await expect(panel.getByRole("status").filter({ hasText: "A newer message replaced the draft." })).toBeVisible();
  await expect(panel.getByText("Depends on an action that did not run")).toHaveCount(0);

  await panel.getByRole("button", { name: "Send draft" }).click();
  await expect(panel.getByRole("status").filter({ hasText: "Sent." })).toBeVisible();
  expect(backend.releases).toEqual([{ heldReplyId: "held-2", body: {} }]);
});

test("a second operator whose release comes a moment late sees it was already released, with focus kept", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installDraftReviewBackend(page, { teammateReleasesFirst: true });

  const { row, panel } = await openDraft(page);
  await panel.getByRole("button", { name: "Send draft" }).click();

  await expect(panel.getByRole("status").filter({ hasText: "Already released." })).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(panel.getByRole("button", { name: "Send draft" })).toHaveCount(0);
  await expect(row).toHaveCount(0);
  expect(backend.releases).toEqual([]);
});

test("a release refused because the mailbox settings changed keeps the draft, says why, and keeps focus", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installDraftReviewBackend(page, { refuseRelease: "policy_changed" });

  const { row, panel } = await openDraft(page);
  await panel.getByRole("button", { name: "Send draft" }).click();

  await expect(panel.getByRole("status").filter({ hasText: "The mailbox settings changed. Nothing was sent." })).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(panel.getByRole("textbox", { name: "Draft reply text" })).toHaveValue(draftText);
  await expect(row).toBeVisible();
  expect(backend.releases).toEqual([]);
});

test("a release refused because sending is not verified keeps the draft and names the step that fixes it", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installDraftReviewBackend(page, { refuseRelease: "email_sending_not_verified" });

  const { row, panel } = await openDraft(page);
  await panel.getByRole("button", { name: "Send draft" }).click();

  await expect(panel.getByRole("status").filter({
    hasText: "Sending is not verified for this mailbox. Verify customer.test in Settings, then send again.",
  })).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(panel.getByRole("textbox", { name: "Draft reply text" })).toHaveValue(draftText);
  await expect(row).toBeVisible();
  expect(backend.releases).toEqual([]);
});

test("a release refused because the mailbox can no longer send keeps the draft and says so", async ({ page }) => {
  await seedDashboardStorage(page);
  const backend = await installDraftReviewBackend(page, { refuseRelease: "channel_not_ready" });

  const { row, panel } = await openDraft(page);
  await panel.getByRole("button", { name: "Send draft" }).click();

  await expect(panel.getByRole("status").filter({ hasText: "This mailbox can no longer send. Nothing was sent." })).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(panel.getByRole("textbox", { name: "Draft reply text" })).toHaveValue(draftText);
  await expect(row).toBeVisible();
  expect(backend.releases).toEqual([]);
});

test("the email card offers Draft for review when the server supports it, and creates a draft mailbox", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const created: unknown[] = [];
  let mailbox: Record<string, unknown> | null = null;
  await page.route("**/backend/api/v1/workspaces/*/email-channel**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(`/backend/api/v1/workspaces/${workspaceId}/email-channel`, "");
    if (request.method() === "GET" && path === "") {
      return json(route, {
        configured: true,
        inboundDomain: "in.radioso.test",
        supportedModes: ["operator_only", "draft"],
        defaultMode: "draft",
        domains: [],
        mailboxes: mailbox ? [mailbox] : [],
      });
    }
    if (request.method() === "POST" && path === "/mailboxes") {
      const body = request.postDataJSON() as Record<string, unknown>;
      created.push(body);
      mailbox = {
        id: mailboxId,
        address: body.address,
        displayName: body.displayName,
        agentId: body.agentId ?? null,
        domainId: "domain-1",
        relayAddress: "r-7f3a@in.radioso.test",
        engagementMode: body.engagementMode,
        enabled: true,
        policyVersion: 1,
        threadSendBudget: 3,
        hourlyGenerationBudget: 30,
        silenceThresholdHours: 72,
        receiving: { state: "waiting_for_first_message", lastReceivedAt: null },
        sending: { state: "not_verified" },
        plusAddressVerified: false,
        setupCheck: null,
      };
      return json(route, mailbox, 201);
    }
    if (request.method() === "GET" && path === `/mailboxes/${mailboxId}` && mailbox) return json(route, mailbox);
    if (request.method() === "GET" && path === `/mailboxes/${mailboxId}/events`) return json(route, { items: [], nextCursor: null });
    return refuse(route, 404, "not_found", `Unhandled email channel route: ${request.method()} ${path}`);
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=email-channel`);
  const card = page.locator("#email-channel");
  const modes = card.getByRole("group", { name: "Mode" });
  await expect(modes.getByRole("button")).toHaveText(["Operator only", "Draft for review"]);
  await expect(modes.getByRole("button", { name: "Draft for review" })).toHaveAttribute("aria-pressed", "true");

  await card.getByLabel("Address", { exact: true }).fill("support@customer.test");
  await card.getByLabel("Display name").fill("Support");
  await card.getByRole("button", { name: "Add mailbox" }).click();

  await expect(card.getByText("Support · Mode: Draft for review")).toBeVisible();
  expect(created).toEqual([
    { address: "support@customer.test", displayName: "Support", agentId: defaultAgentId, engagementMode: "draft" },
  ]);
});
