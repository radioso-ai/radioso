import { describe, expect, it, vi } from "vitest";

import { SlackInteractivityHandler } from "../../../src/modules/slack/public.js";
import type { ConversationRecord } from "../../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../../src/db/repositories/messageRepository.js";
import {
  ConversationOwnershipService,
  type ConversationOwnershipRecord,
} from "../../../src/modules/handoff/public.js";
import type { SlackInstallationRecord } from "../../../src/modules/slack/public.js";
import { InMemoryActionOutbox, InMemoryConversationOwnershipRepository } from "../../support/fakes.js";

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
  ownerUserId: "user_1",
  ownerProfile: { displayName: "Dana Scully", email: "dana@example.com" },
  ownerStoredLabel: "Dana Scully",
  reason: "operator_takeover",
  version: 3,
  takenOverAt: new Date("2026-01-01T00:00:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

const aiOwnedRecord = (version: number): ConversationOwnershipRecord => ownershipRecord({
  state: "ai_owned",
  ownerAccountId: null,
  ownerUserId: null,
  ownerProfile: null,
  ownerStoredLabel: null,
  reason: null,
  version,
  takenOverAt: null,
});

const blockPayload = (actionId: string, value: Record<string, unknown>, slackUserId = "U1") => ({
  type: "block_actions" as const,
  team: { id: "T1" },
  user: { id: slackUserId },
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

const message: MessageRecord = {
  id: "msg_1",
  conversationId: "conv_1",
  workspaceId: "ws_conversation",
  role: "assistant",
  source: "human_agent",
  content: "Hello customer",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

type Identity = { accountId: string; userId: string; displayName: string | null } | { rejected: true };

const slackResponses = () => {
  const responsePosts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const responseUrlClient = {
    postToResponseUrl: vi.fn(async (url: string, body: Record<string, unknown>) => {
      responsePosts.push({ url, body });
    }),
  };
  return { responsePosts, responseUrlClient };
};

/** The handler over a stubbed ownership service: checks how Slack presents each outcome. */
const createHandler = (overrides: {
  identity?: Identity;
  currentOwnership?: ConversationOwnershipRecord | null;
  conversationLinks?: { resolve: (input: { workspaceId: string; conversationId: string }) => Promise<string | null> };
  takeOverResult?: Awaited<ReturnType<ConversationOwnershipService["takeOver"]>>;
  handBackResult?: Awaited<ReturnType<ConversationOwnershipService["handBack"]>>;
  replyResult?: Awaited<ReturnType<ConversationOwnershipService["reply"]>>;
  replyRefusal?: Awaited<ReturnType<ConversationOwnershipService["replyRefusal"]>>;
} = {}) => {
  const { responsePosts, responseUrlClient } = slackResponses();
  const ownership = {
    load: vi.fn(async () => (overrides.currentOwnership === undefined ? ownershipRecord() : overrides.currentOwnership)),
    takeOver: vi.fn(async () => overrides.takeOverResult ?? { ok: true as const, changed: true, record: ownershipRecord({ version: 2 }) }),
    handBack: vi.fn(async () => overrides.handBackResult ?? { ok: true as const, changed: true, record: aiOwnedRecord(4) }),
    reply: vi.fn(async () => overrides.replyResult ?? { ok: true as const, message, record: ownershipRecord() }),
    replyRefusal: vi.fn(async () => overrides.replyRefusal ?? null),
  };
  const viewsOpen = vi.fn(async () => {});
  const identityResolver = {
    resolve: vi.fn(async (): Promise<Identity> => overrides.identity ?? {
      accountId: "acct_1",
      userId: "user_1",
      displayName: "Dana on Slack",
    }),
  };
  const handler = new SlackInteractivityHandler({
    installations: { findByTeamId: vi.fn(async () => installation) },
    identityResolver,
    conversationOwnership: ownership,
    slackViews: { open: viewsOpen },
    responseUrlClient,
    conversationLinks: overrides.conversationLinks,
  });
  return { handler, ownership, viewsOpen, responsePosts, identityResolver };
};

const actor = { accountId: "acct_1", userId: "user_1", workspaceId: "ws_conversation" };
const slackAudit = { slackOperator: { slackUserId: "U1", displayName: "Dana on Slack" } };

describe("SlackInteractivityHandler ownership branch", () => {
  it("links the updated Slack message to the resolved conversation permalink", async () => {
    const permalink = "https://app.radioso.ai/w/support-abc/activity?tab=all&filter=chat&itemKind=chat&itemId=conv_1";
    const resolve = vi.fn(async () => permalink);
    const { handler, responsePosts } = createHandler({ conversationLinks: { resolve } });

    await handler.handleBlockActions(blockPayload("ownership_takeover", {
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
    }));

    expect(resolve).toHaveBeenCalledWith({ workspaceId: "ws_conversation", conversationId: "conv_1" });
    expect(JSON.stringify(responsePosts[0].body.blocks)).toContain(`<${permalink.replaceAll("&", "&amp;")}|Open in dashboard>`);
  });

  it("updates the Slack message without a link rather than a dead one when no resolver is wired", async () => {
    const { handler, responsePosts } = createHandler();

    await handler.handleBlockActions(blockPayload("ownership_takeover", {
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
    }));

    const blocks = responsePosts[0].body.blocks as Array<{ type: string }>;
    expect(blocks.filter((block) => block.type === "context")).toHaveLength(0);
  });

  it("links the hand-back update to the resolved conversation permalink", async () => {
    const permalink = "https://app.radioso.ai/w/support-abc/activity?tab=all&filter=chat&itemKind=chat&itemId=conv_1";
    const resolve = vi.fn(async () => permalink);
    const { handler, responsePosts } = createHandler({ conversationLinks: { resolve } });

    await handler.handleBlockActions(blockPayload("ownership_handback", {
      conversationId: "conv_1",
      version: 2,
    }));

    expect(resolve).toHaveBeenCalledWith({ workspaceId: "ws_conversation", conversationId: "conv_1" });
    expect(JSON.stringify(responsePosts[0].body.blocks)).toContain(`<${permalink.replaceAll("&", "&amp;")}|Open in dashboard>`);
  });

  it("takes over as the resolved teammate and shows talk and handback", async () => {
    const { handler, ownership, responsePosts, identityResolver } = createHandler();

    await handler.handleBlockActions(blockPayload("ownership_takeover", {
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
    }));

    expect(identityResolver.resolve).toHaveBeenCalledWith({ installation, workspaceId: "ws_conversation", slackUserId: "U1" });
    expect(ownership.takeOver).toHaveBeenCalledWith(actor, {
      conversationId: "conv_1",
      auditContext: slackAudit,
    });
    expect(responsePosts[0].body).toMatchObject({ replace_original: true, text: "Handled by Dana Scully" });
    const actions = (responsePosts[0].body.blocks as Array<Record<string, unknown>>)
      .find((block) => block.type === "actions") as { elements: Array<Record<string, unknown>> };
    expect(actions.elements.map((element) => JSON.parse(element.value as string))).toEqual([
      { conversationId: "conv_1", workspaceId: "ws_conversation", version: 2 },
      { conversationId: "conv_1", version: 2 },
    ]);
  });

  it("names a new owner without a Radioso display name by their Slack name, never their email", async () => {
    const { handler, responsePosts } = createHandler({
      takeOverResult: {
        ok: true,
        changed: true,
        record: ownershipRecord({ version: 2, ownerProfile: { displayName: null, email: "dana@example.com" }, ownerStoredLabel: "dana@example.com" }),
      },
    });

    await handler.handleBlockActions(blockPayload("ownership_takeover", { conversationId: "conv_1", workspaceId: "ws_conversation" }));

    expect(responsePosts[0].body.text).toBe("Handled by Dana on Slack");
    expect(JSON.stringify(responsePosts[0].body)).not.toContain("dana@example.com");
  });

  it("names an owner whose saved display name is shaped like an email by their Slack name instead", async () => {
    const { handler, responsePosts } = createHandler({
      takeOverResult: {
        ok: true,
        changed: true,
        // Saved before display names were validated.
        record: ownershipRecord({ version: 2, ownerProfile: { displayName: "dana@example.com", email: "dana@example.com" } }),
      },
    });

    await handler.handleBlockActions(blockPayload("ownership_takeover", { conversationId: "conv_1", workspaceId: "ws_conversation" }));

    expect(responsePosts[0].body.text).toBe("Handled by Dana on Slack");
    expect(JSON.stringify(responsePosts[0].body)).not.toContain("dana@example.com");
  });

  it("names an owner a teammate when the Slack name is shaped like an email too", async () => {
    const { handler, responsePosts } = createHandler({
      identity: { accountId: "acct_1", userId: "user_1", displayName: "dana\uFF20example.com" },
      takeOverResult: {
        ok: true,
        changed: true,
        record: ownershipRecord({ version: 2, ownerProfile: { displayName: null, email: "dana@example.com" } }),
      },
    });

    await handler.handleBlockActions(blockPayload("ownership_takeover", { conversationId: "conv_1", workspaceId: "ws_conversation" }));

    expect(responsePosts[0].body.text).toBe("Handled by a teammate");
  });

  it("refuses Take over on a conversation a teammate holds, privately, pointing at Reassign in the dashboard", async () => {
    const { handler, responsePosts } = createHandler({
      takeOverResult: {
        ok: false,
        refusal: "held_by_teammate",
        record: ownershipRecord({ ownerUserId: "user_fox", ownerProfile: { displayName: "Fox <Mulder>", email: "fox@example.com" } }),
      },
      conversationLinks: { resolve: async () => "https://app.radioso.test/w/ws/inbox?conversation=conv_1" },
    });

    await handler.handleBlockActions(blockPayload("ownership_takeover", { conversationId: "conv_1", workspaceId: "ws_conversation" }));

    expect(responsePosts).toHaveLength(1);
    expect(responsePosts[0].body).toEqual({
      response_type: "ephemeral",
      replace_original: false,
      text: "Fox &lt;Mulder&gt; is handling this. <https://app.radioso.test/w/ws/inbox?conversation=conv_1|Reassign in dashboard>",
    });
  });

  it("refuses Take over on a teammate's conversation without a link when none resolves", async () => {
    const { handler, responsePosts } = createHandler({
      takeOverResult: { ok: false, refusal: "held_by_teammate", record: ownershipRecord({ ownerUserId: "user_fox" }) },
    });

    await handler.handleBlockActions(blockPayload("ownership_takeover", { conversationId: "conv_1", workspaceId: "ws_conversation" }));

    expect(responsePosts[0].body).toEqual({
      response_type: "ephemeral",
      replace_original: false,
      text: "Dana Scully is handling this.",
    });
  });

  it("names an owner with neither name a teammate", async () => {
    const { handler, responsePosts } = createHandler({
      identity: { accountId: "acct_1", userId: "user_1", displayName: null },
      takeOverResult: {
        ok: true,
        changed: true,
        record: ownershipRecord({ version: 2, ownerProfile: { displayName: null, email: "dana@example.com" } }),
      },
    });

    await handler.handleBlockActions(blockPayload("ownership_takeover", { conversationId: "conv_1", workspaceId: "ws_conversation" }));

    expect(responsePosts[0].body.text).toBe("Handled by a teammate");
  });

  it("escapes a display name that tries to mention the channel", async () => {
    const { handler, responsePosts } = createHandler({
      takeOverResult: {
        ok: true,
        changed: true,
        record: ownershipRecord({ version: 2, ownerProfile: { displayName: "<!channel>", email: "dana@example.com" } }),
      },
    });

    await handler.handleBlockActions(blockPayload("ownership_takeover", { conversationId: "conv_1", workspaceId: "ws_conversation" }));

    expect(responsePosts[0].body.text).toBe("Handled by &lt;!channel&gt;");
    expect(JSON.stringify(responsePosts[0].body)).not.toContain("<!channel>");
  });

  it("rejects takeover for non-members without mutating ownership", async () => {
    const { handler, ownership, responsePosts } = createHandler({ identity: { rejected: true } });

    await handler.handleBlockActions(blockPayload("ownership_takeover", {
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
    }));

    expect(ownership.takeOver).not.toHaveBeenCalled();
    expect(responsePosts[0].body).toMatchObject({
      response_type: "ephemeral",
      text: "You're not a Radioso operator on this workspace.",
    });
  });

  it("posts an ephemeral refresh when takeover loses the ownership race", async () => {
    const { handler, responsePosts } = createHandler({
      takeOverResult: { ok: false, refusal: "stale", record: ownershipRecord({ version: 4 }) },
    });

    await handler.handleBlockActions(blockPayload("ownership_takeover", {
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
    }));

    expect(responsePosts[0].body).toMatchObject({
      response_type: "ephemeral",
      text: "Conversation ownership changed. Refreshing.",
    });
  });

  it("hands back with the expected version and updates the Slack message", async () => {
    const { handler, ownership, responsePosts } = createHandler();

    await handler.handleBlockActions(blockPayload("ownership_handback", {
      conversationId: "conv_1",
      version: 3,
    }));

    expect(ownership.handBack).toHaveBeenCalledWith(actor, { conversationId: "conv_1", expectedVersion: 3, auditContext: slackAudit });
    expect(responsePosts[0].body).toMatchObject({ replace_original: true });
    expect(JSON.stringify(responsePosts[0].body.blocks)).toContain("ownership_takeover");
    expect(JSON.stringify(responsePosts[0].body.blocks)).not.toContain("ownership_talk");
  });

  it("tells a teammate who does not own the conversation who does, and leaves the card alone on hand back", async () => {
    const { handler, responsePosts } = createHandler({
      handBackResult: { ok: false, refusal: "held_by_teammate", record: ownershipRecord({ ownerProfile: { displayName: "Fox <Mulder>", email: "fox@example.com" } }) },
    });

    await handler.handleBlockActions(blockPayload("ownership_handback", { conversationId: "conv_1", version: 3 }));

    expect(responsePosts).toHaveLength(1);
    expect(responsePosts[0].body).toMatchObject({
      response_type: "ephemeral",
      replace_original: false,
      text: "Fox &lt;Mulder&gt; is handling this.",
    });
  });

  it("posts an ephemeral refresh when handback loses the ownership race", async () => {
    const { handler, responsePosts } = createHandler({
      handBackResult: { ok: false, refusal: "stale", record: ownershipRecord({ version: 4 }) },
    });

    await handler.handleBlockActions(blockPayload("ownership_handback", {
      conversationId: "conv_1",
      version: 3,
    }));

    expect(responsePosts[0].body).toMatchObject({
      response_type: "ephemeral",
      text: "Conversation ownership changed. Refreshing.",
    });
  });

  it("opens a reply modal for a teammate who may reply", async () => {
    const { handler, viewsOpen, responsePosts, ownership } = createHandler();

    await handler.handleBlockActions(blockPayload("ownership_talk", {
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
      version: 3,
    }));

    expect(ownership.replyRefusal).toHaveBeenCalledWith(actor, "conv_1");
    expect(viewsOpen).toHaveBeenCalledWith({
      installation,
      triggerId: "trigger_1",
      view: expect.objectContaining({
        callback_id: "ownership_reply",
        private_metadata: JSON.stringify({ conversationId: "conv_1", workspaceId: "ws_conversation", version: 3 }),
      }),
    });
    expect(responsePosts).toHaveLength(0);
  });

  it("does not open the reply modal while a teammate holds the conversation", async () => {
    const { handler, viewsOpen, responsePosts } = createHandler({
      replyRefusal: { refusal: "held_by_teammate", record: ownershipRecord({ ownerProfile: { displayName: "Fox Mulder", email: "fox@example.com" } }) },
    });

    await handler.handleBlockActions(blockPayload("ownership_talk", {
      conversationId: "conv_1",
      workspaceId: "ws_conversation",
      version: 3,
    }));

    expect(viewsOpen).not.toHaveBeenCalled();
    expect(responsePosts[0].body).toMatchObject({ response_type: "ephemeral", text: "Fox Mulder is handling this." });
  });

  it("submits a modal reply through the ownership service at the version the modal was opened on", async () => {
    const { handler, ownership } = createHandler();

    const result = await handler.handleViewSubmission(viewPayload(" Hello customer "));

    expect(result).toBeUndefined();
    expect(ownership.reply).toHaveBeenCalledWith(actor, {
      conversationId: "conv_1",
      message: "Hello customer",
      expectedVersion: 3,
      auditContext: slackAudit,
    });
  });

  it("returns modal field errors for empty text, a teammate's conversation, or a stale modal", async () => {
    const empty = createHandler();
    await expect(empty.handler.handleViewSubmission(viewPayload("   "))).resolves.toEqual({
      response_action: "errors",
      errors: { ownership_reply_message: "Enter a reply." },
    });
    expect(empty.ownership.reply).not.toHaveBeenCalled();

    const held = createHandler({
      replyResult: { ok: false, refusal: "held_by_teammate", record: ownershipRecord({ ownerProfile: { displayName: "Fox Mulder", email: "fox@example.com" } }) },
    });
    await expect(held.handler.handleViewSubmission(viewPayload("Hello"))).resolves.toEqual({
      response_action: "errors",
      errors: { ownership_reply_message: "Fox Mulder is handling this." },
    });

    const stale = createHandler({ replyResult: { ok: false, refusal: "stale", record: ownershipRecord({ version: 4 }) } });
    await expect(stale.handler.handleViewSubmission(viewPayload("Stale reply"))).resolves.toEqual({
      response_action: "errors",
      errors: { ownership_reply_message: "This conversation changed. Take over again before replying." },
    });
  });
});

describe("SlackInteractivityHandler ownership rules through the ownership service", () => {
  const dana = { accountId: "acct_1", userId: "user_dana", displayName: "Dana on Slack" };
  const fox = { accountId: "acct_1", userId: "user_fox", displayName: "Fox on Slack" };
  const operators: Record<string, { userId: string; label: string }> = {
    user_dana: { userId: "user_dana", label: "dana@example.com" },
    user_fox: { userId: "user_fox", label: "fox@example.com" },
  };

  const createRealHandler = (options: { auditFails?: boolean } = {}) => {
    const { responsePosts, responseUrlClient } = slackResponses();
    const ownership = new InMemoryConversationOwnershipRepository();
    const outbox = new InMemoryActionOutbox();
    const replies = { write: vi.fn(async () => message), deliver: vi.fn(async () => undefined) };
    const replyScope = { messages: { create: vi.fn() }, conversations: { touch: vi.fn() } };
    const service = new ConversationOwnershipService({
      conversations: { findByIdAndWorkspaceId: async (id: string) => ({ id }) as ConversationRecord },
      ownership,
      transfers: { run: (work) => work({ ownership, outbox }) },
      replyWrites: { run: (work) => work({ ownership, reply: replyScope }) },
      operators: { find: async ({ userId }: { userId: string }) => operators[userId] ?? null },
      operatorIdentities: {
        resolve: async ({ userId }: { userId: string }) => ({ userId, teammateLabel: operators[userId].label, replySignature: null }),
      },
      replies,
      audit: { record: vi.fn(options.auditFails ? async () => { throw new Error("audit unavailable"); } : async () => undefined) },
      logger: { warn: vi.fn() },
    });
    const bySlackUser: Record<string, typeof dana> = { U_DANA: dana, U_FOX: fox };
    const viewsOpen = vi.fn(async () => {});
    const handler = new SlackInteractivityHandler({
      installations: { findByTeamId: async () => installation },
      identityResolver: {
        resolve: async ({ slackUserId }: { slackUserId: string }) => bySlackUser[slackUserId] ?? { rejected: true as const },
      },
      conversationOwnership: service,
      slackViews: { open: viewsOpen },
      responseUrlClient,
    });
    return { handler, ownership, outbox, responsePosts, viewsOpen, replies };
  };

  it("leaves a conversation a teammate holds with them when another clicks a stale Take over", async () => {
    const { handler, ownership, outbox, responsePosts } = createRealHandler();
    await handler.handleBlockActions(blockPayload("ownership_takeover", { conversationId: "conv_1", workspaceId: "ws_conversation" }, "U_DANA"));

    await handler.handleBlockActions(blockPayload("ownership_takeover", { conversationId: "conv_1", workspaceId: "ws_conversation" }, "U_FOX"));

    await expect(ownership.load("conv_1")).resolves.toMatchObject({ ownerUserId: "user_dana", version: 1 });
    expect(outbox.items).toEqual([]);
    expect(responsePosts.at(-1)?.body).toEqual({
      response_type: "ephemeral",
      replace_original: false,
      text: "dana@example.com is handling this.",
    });
  });

  it("keeps the card current when a taken-over conversation's audit record fails", async () => {
    const { handler, ownership, responsePosts } = createRealHandler({ auditFails: true });

    await handler.handleBlockActions(blockPayload("ownership_takeover", { conversationId: "conv_1", workspaceId: "ws_conversation" }, "U_DANA"));
    await handler.handleBlockActions(blockPayload("ownership_handback", { conversationId: "conv_1", version: 1 }, "U_DANA"));

    await expect(ownership.load("conv_1")).resolves.toMatchObject({ state: "ai_owned", version: 2 });
    expect(responsePosts.map((post) => post.body.replace_original)).toEqual([true, true]);
    expect(responsePosts[0].body).toMatchObject({ text: "Handled by Dana on Slack" });
  });

  it("refuses Talk and Hand back from a teammate who does not own the conversation", async () => {
    const { handler, ownership, responsePosts, viewsOpen } = createRealHandler();
    await handler.handleBlockActions(blockPayload("ownership_takeover", { conversationId: "conv_1", workspaceId: "ws_conversation" }, "U_DANA"));

    await handler.handleBlockActions(blockPayload("ownership_talk", { conversationId: "conv_1", workspaceId: "ws_conversation", version: 1 }, "U_FOX"));
    await handler.handleBlockActions(blockPayload("ownership_handback", { conversationId: "conv_1", version: 1 }, "U_FOX"));

    expect(viewsOpen).not.toHaveBeenCalled();
    expect(responsePosts.slice(1).map((post) => post.body)).toEqual([
      { response_type: "ephemeral", replace_original: false, text: "dana@example.com is handling this." },
      { response_type: "ephemeral", replace_original: false, text: "dana@example.com is handling this." },
    ]);
    await expect(ownership.load("conv_1")).resolves.toMatchObject({ state: "human_owned", ownerUserId: "user_dana", version: 1 });
  });
});
