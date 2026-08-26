import { describe, expect, it, vi } from "vitest";

import { SlackInteractivityHandler } from "../../../src/modules/slack/public.js";
import type { MessageRecord } from "../../../src/db/repositories/messageRepository.js";
import type {
  ConversationOwnershipMutationResult,
  ConversationOwnershipRecord,
} from "../../../src/modules/handoff/public.js";
import type { SlackInstallationRecord } from "../../../src/modules/slack/public.js";

const installation: SlackInstallationRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  connectionId: "conn_1",
  workspaceId: "ws_1",
  accountId: "acct_install",
  teamId: "T1",
  teamName: "Team",
  botUserId: "B1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const ownershipRecord = (overrides: Partial<ConversationOwnershipRecord> = {}): ConversationOwnershipRecord => ({
  conversationId: "conv_1",
  workspaceId: "ws_conversation",
  state: "human_owned",
  ownerAccountId: "acct_1",
  ownerDisplayName: "Dana",
  reason: "operator_takeover",
  version: 3,
  takenOverAt: new Date("2026-01-01T00:00:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

const blockPayload = (actionId: string, value: Record<string, unknown>) => ({
  type: "block_actions" as const,
  team: { id: "T1" },
  user: { id: "U1" },
  trigger_id: "trigger_1",
  response_url: "https://hooks.slack.com/actions/1",
  actions: [{ action_id: actionId, value: JSON.stringify(value) }],
});

const viewPayload = (value: string) => ({
  type: "view_submission" as const,
  team: { id: "T1" },
  user: { id: "U1" },
  view: {
    callback_id: "ownership_reply",
    private_metadata: JSON.stringify({ conversationId: "conv_1", workspaceId: "ws_conversation", version: 3 }),
    state: {
      values: {
        ownership_reply_message: {
          ownership_reply_text: { type: "plain_text_input", value },
        },
      },
    },
  },
});

const createHandler = (overrides: {
  identity?: { accountId: string; userId: string | null; displayName: string | null } | { rejected: true };
  currentOwnership?: ConversationOwnershipRecord | null;
  takeOverResult?: ConversationOwnershipMutationResult;
  handBackResult?: ConversationOwnershipMutationResult;
} = {}) => {
  const responsePosts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const ownership = {
    load: vi.fn(async () => overrides.currentOwnership ?? ownershipRecord()),
    takeOver: vi.fn(async (): Promise<ConversationOwnershipMutationResult> =>
      overrides.takeOverResult ?? { ok: true, changed: true, record: ownershipRecord({ version: 2 }) }),
    handBack: vi.fn(async (): Promise<ConversationOwnershipMutationResult> => overrides.handBackResult ?? {
      ok: true,
      changed: true,
      record: ownershipRecord({
        state: "ai_owned",
        ownerAccountId: null,
        ownerDisplayName: null,
        reason: null,
        version: 4,
        takenOverAt: null,
      }),
    }),
  };
  const viewsOpen = vi.fn(async () => {});
  const operatorReply = {
    reply: vi.fn(async (): Promise<MessageRecord> => ({
      id: "msg_1",
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
      role: "assistant",
      source: "human_agent",
      content: "Hello customer",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })),
  };
  const audit = { record: vi.fn(async () => {}) };
  const publisher = { enqueue: vi.fn(() => ({ accepted: true as const, coalesced: false })) };
  const identityResolver = {
    resolve: vi.fn(async () => overrides.identity ?? {
      accountId: "acct_1",
      userId: "user_1",
      displayName: "Dana",
    }),
  };
  const handler = new SlackInteractivityHandler({
    installations: { findByTeamId: vi.fn(async () => installation) },
    identityResolver,
    conversationOwnership: ownership,
    operatorReplyService: operatorReply,
    slackViews: { open: viewsOpen },
    responseUrlClient: {
      postToResponseUrl: vi.fn(async (url, body) => {
        responsePosts.push({ url, body });
      }),
    },
    audit,
    workspaceInvalidationPublisher: publisher,
  });
  return { handler, ownership, viewsOpen, operatorReply, responsePosts, audit, identityResolver, publisher };
};

describe("SlackInteractivityHandler ownership branch", () => {
  it("takes over a conversation, audits it, and updates the Slack message with talk and handback", async () => {
    const { handler, ownership, responsePosts, audit, identityResolver, publisher } = createHandler();

    await handler.handleBlockActions(blockPayload("ownership_takeover", {
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
    }));

    expect(ownership.takeOver).toHaveBeenCalledWith({
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
      accountId: "acct_1",
      displayName: "Dana",
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "acct_1",
      workspaceId: "ws_conversation",
      eventType: "hitl.ownership",
      eventStatus: "success",
      metadata: expect.objectContaining({ action: "taken_over", conversationId: "conv_1" }),
    }));
    expect(identityResolver.resolve).toHaveBeenCalledWith({
      installation,
      workspaceId: "ws_conversation",
      slackUserId: "U1",
    });
    expect(publisher.enqueue).toHaveBeenCalledWith("ws_conversation", ["conversation.ownership_changed"]);
    expect(responsePosts[0]!.body).toMatchObject({ replace_original: true });
    expect(JSON.stringify(responsePosts[0]!.body.blocks)).toContain("ownership_talk");
    const actions = (responsePosts[0]!.body.blocks as Array<Record<string, unknown>>)
      .find((block) => block.type === "actions") as { elements: Array<Record<string, unknown>> };
    expect(actions.elements.map((element) => JSON.parse(element.value as string))).toEqual([
      { conversationId: "conv_1", workspaceId: "ws_conversation", version: 2 },
      { conversationId: "conv_1", version: 2 },
    ]);
  });

  it("rejects takeover for non-members without mutating ownership", async () => {
    const { handler, ownership, responsePosts, audit } = createHandler({ identity: { rejected: true } });

    await handler.handleBlockActions(blockPayload("ownership_takeover", {
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
    }));

    expect(ownership.takeOver).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(responsePosts[0]!.body).toMatchObject({
      response_type: "ephemeral",
      text: "You're not a Radioso operator on this workspace.",
    });
  });

  it("posts an ephemeral refresh when takeover loses the ownership race", async () => {
    const { handler, responsePosts, audit } = createHandler({
      takeOverResult: { ok: false, changed: false, record: ownershipRecord({ ownerDisplayName: "Lee", version: 4 }) },
    });

    await handler.handleBlockActions(blockPayload("ownership_takeover", {
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
    }));

    expect(audit.record).not.toHaveBeenCalled();
    expect(responsePosts[0]!.body).toMatchObject({
      response_type: "ephemeral",
      text: "Conversation ownership changed. Refreshing.",
    });
  });

  it("does not publish an ownership invalidation for a truthful takeover no-op", async () => {
    const { handler, publisher } = createHandler({
      takeOverResult: { ok: true, changed: false, record: ownershipRecord({ version: 2 }) },
    });

    await handler.handleBlockActions(blockPayload("ownership_takeover", {
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
    }));

    expect(publisher.enqueue).not.toHaveBeenCalled();
  });

  it("hands back with the expected version and updates the Slack message", async () => {
    const { handler, ownership, responsePosts, audit, publisher } = createHandler();

    await handler.handleBlockActions(blockPayload("ownership_handback", {
      conversationId: "conv_1",
      version: 3,
    }));

    expect(ownership.handBack).toHaveBeenCalledWith({ conversationId: "conv_1", expectedVersion: 3 });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ action: "handed_back", conversationId: "conv_1" }),
    }));
    expect(publisher.enqueue).toHaveBeenCalledWith("ws_conversation", ["conversation.ownership_changed"]);
    expect(responsePosts[0]!.body).toMatchObject({ replace_original: true });
    expect(JSON.stringify(responsePosts[0]!.body.blocks)).toContain("ownership_takeover");
    expect(JSON.stringify(responsePosts[0]!.body.blocks)).not.toContain("ownership_talk");
  });

  it("posts an ephemeral refresh when handback loses the ownership race", async () => {
    const { handler, responsePosts, audit } = createHandler({
      handBackResult: { ok: false, changed: false, record: ownershipRecord({ version: 4 }) },
    });

    await handler.handleBlockActions(blockPayload("ownership_handback", {
      conversationId: "conv_1",
      version: 3,
    }));

    expect(audit.record).not.toHaveBeenCalled();
    expect(responsePosts[0]!.body).toMatchObject({
      response_type: "ephemeral",
      text: "Conversation ownership changed. Refreshing.",
    });
  });

  it("opens a reply modal only for human-owned conversations", async () => {
    const { handler, viewsOpen, responsePosts, identityResolver } = createHandler();

    await handler.handleBlockActions(blockPayload("ownership_talk", {
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
      version: 3,
    }));

    expect(viewsOpen).toHaveBeenCalledWith({
      installation,
      triggerId: "trigger_1",
      view: expect.objectContaining({
        callback_id: "ownership_reply",
        private_metadata: JSON.stringify({ conversationId: "conv_1", workspaceId: "ws_conversation", version: 3 }),
      }),
    });
    expect(identityResolver.resolve).toHaveBeenCalledWith({
      installation,
      workspaceId: "ws_conversation",
      slackUserId: "U1",
    });
    expect(responsePosts).toHaveLength(0);
  });

  it("does not open the reply modal when the conversation is not human-owned", async () => {
    const { handler, viewsOpen, responsePosts } = createHandler({
      currentOwnership: ownershipRecord({ state: "ai_owned", ownerAccountId: null, ownerDisplayName: null }),
    });

    await handler.handleBlockActions(blockPayload("ownership_talk", {
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
      version: 3,
    }));

    expect(viewsOpen).not.toHaveBeenCalled();
    expect(responsePosts[0]!.body).toMatchObject({
      response_type: "ephemeral",
    });
  });

  it("submits a modal reply through OperatorReplyService", async () => {
    const { handler, operatorReply } = createHandler();

    const result = await handler.handleViewSubmission(viewPayload(" Hello customer "));

    expect(result).toBeUndefined();
    expect(operatorReply.reply).toHaveBeenCalledWith({
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
      accountId: "acct_1",
      displayName: "Dana",
      message: "Hello customer",
    });
  });

  it("returns modal field errors for empty text or non-human-owned conversations", async () => {
    const empty = createHandler();
    const emptyResult = await empty.handler.handleViewSubmission(viewPayload("   "));
    expect(emptyResult).toEqual({
      response_action: "errors",
      errors: { ownership_reply_message: "Enter a reply." },
    });
    expect(empty.operatorReply.reply).not.toHaveBeenCalled();

    const aiOwned = createHandler({
      currentOwnership: ownershipRecord({ state: "ai_owned", ownerAccountId: null, ownerDisplayName: null }),
    });
    const aiOwnedResult = await aiOwned.handler.handleViewSubmission(viewPayload("Hello"));
    expect(aiOwnedResult).toEqual({
      response_action: "errors",
      errors: { ownership_reply_message: "Take over the conversation before replying." },
    });
    expect(aiOwned.operatorReply.reply).not.toHaveBeenCalled();
  });

  it("rejects a stale reply modal whose version no longer matches current ownership", async () => {
    // Modal was opened at version 3 (viewPayload private_metadata); ownership has since moved to
    // version 4 (handed back + re-taken-over). The stale reply must not reach the customer.
    const stale = createHandler({ currentOwnership: ownershipRecord({ version: 4 }) });

    const result = await stale.handler.handleViewSubmission(viewPayload("Stale reply"));

    expect(result).toEqual({
      response_action: "errors",
      errors: { ownership_reply_message: "This conversation changed. Take over again before replying." },
    });
    expect(stale.operatorReply.reply).not.toHaveBeenCalled();
  });
});
