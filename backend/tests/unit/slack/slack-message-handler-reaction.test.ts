import { describe, expect, it, vi } from "vitest";
import type { ConnectorChatPort } from "@radioso/connector-api";

import {
  SlackMessageHandler,
  type SlackAppMentionEvent,
  type SlackInboundEventEnvelope,
} from "../../../src/modules/connectors/plugins/slack/slackMessageHandler.js";
import type { SlackConversationLinkCreateOutcome } from "../../../src/modules/connectors/plugins/slack/slackPersistence.js";
import type { WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";
import { ChatTurnSupersededError } from "../../../src/modules/chat/services/conversationTurnRegistry.js";

const PROCESSING_REACTION = "eyes";
const ANSWERED_REACTION = "white_check_mark";
const FAILED_REACTION = "x";

interface ReactionCall {
  op: "add" | "remove";
  channel: string;
  timestamp: string;
  name: string;
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const installation = {
  id: "inst-1",
  connectionId: "conn-1",
  oauthConnectionId: "oauth-1",
  workspaceId: "ws-1",
  teamId: "T1",
  teamName: "Team",
  botUserId: "UBOT",
} as never;

const buildHandler = (overrides: {
  reactions: ReactionCall[];
  events: string[];
  postImpl?: (input: { channel: string; text: string; threadTs?: string }) => Promise<{ channel: string; ts: string }>;
  answerImpl?: ConnectorChatPort["answer"];
  getOrCreateConversationLinkImpl?: () => Promise<SlackConversationLinkCreateOutcome>;
  publisher?: WorkspaceInvalidationPublisher;
  info?: (entry: unknown, message?: string) => void;
}) => {
  return new SlackMessageHandler({
    logger: { info: overrides.info ?? (() => undefined), warn: () => undefined, error: () => undefined },
    installations: {
      findByTeamId: async () => installation,
      findByWorkspaceId: async () => null,
      removeByWorkspaceId: async () => false,
    } as never,
    bindings: {
      findAnswerer: async () => ({
        id: "bind-1",
        connectionId: "conn-1",
        workspaceId: "ws-1",
        channelId: null,
        answeringAgentId: "agent-1",
        escalationChannelId: null,
        gapEscalationEnabled: false,
      }),
    } as never,
    installationService: {
      resolveBotTokenForInstallation: async () => "xoxb-token",
      markNeedsReauthForInstallation: async () => undefined,
    } as never,
    persistence: {
      createInboundEvent: async () => true,
      markInboundEventStatus: async (_eventId: string, status: string) => {
        overrides.events.push(status);
      },
      findConversationLink: async () => null,
      findConversationLinkByConversationId: async () => null,
      getOrCreateConversationLink: overrides.getOrCreateConversationLinkImpl ?? (async () => ({
        link: {
          id: "link-1",
          workspaceId: "ws-1",
          installationId: "inst-1",
          slackKey: "mention:T1:C1:1700000000.0001",
          conversationId: "conv-1",
        },
        created: false,
      })),
      upsertConversationLink: async () => undefined,
    } as never,
    chat: {
      answer: overrides.answerImpl ?? (async () => ({ conversationId: "conv-1", answer: "the answer", outcome: "answered" })),
    },
    clientFactory: () => ({
      postMessage: overrides.postImpl ?? (async (input) => ({ channel: input.channel, ts: "ts-reply" })),
      addReaction: async (input: { channel: string; timestamp: string; name: string }) => {
        overrides.reactions.push({ op: "add", ...input });
      },
      removeReaction: async (input: { channel: string; timestamp: string; name: string }) => {
        overrides.reactions.push({ op: "remove", ...input });
      },
    }),
    workspaceInvalidationPublisher: overrides.publisher,
  });
};

const mentionEnvelope: SlackInboundEventEnvelope & { event: SlackAppMentionEvent } = {
  eventId: "Ev1",
  teamId: "T1",
  event: {
    type: "app_mention",
    channel: "C1",
    user: "U1",
    text: "<@UBOT> hello",
    ts: "1700000000.0001",
  },
};

describe("SlackMessageHandler reaction lifecycle", () => {
  it("adds an eyes reaction before answering and swaps it for a checkmark once the reply is posted", async () => {
    const reactions: ReactionCall[] = [];
    const events: string[] = [];
    const handler = buildHandler({ reactions, events });

    await handler.handleAppMention(mentionEnvelope);

    expect(reactions).toEqual([
      { op: "add", channel: "C1", timestamp: "1700000000.0001", name: PROCESSING_REACTION },
      { op: "remove", channel: "C1", timestamp: "1700000000.0001", name: PROCESSING_REACTION },
      { op: "add", channel: "C1", timestamp: "1700000000.0001", name: ANSWERED_REACTION },
    ]);
    expect(events).toContain("processed");
  });

  it("publishes conversation.created only for the persisted create outcome", async () => {
    const publisher: WorkspaceInvalidationPublisher = {
      enqueue: vi.fn(() => ({ accepted: true as const, coalesced: false })),
    };
    const handler = buildHandler({
      reactions: [],
      events: [],
      publisher,
      getOrCreateConversationLinkImpl: async () => ({
        link: {
          id: "link-1",
          workspaceId: "ws-1",
          installationId: "inst-1",
          slackKey: "mention:T1:C1:1700000000.0001",
          conversationId: "conv-1",
        },
        created: true,
      }),
    });

    await handler.handleAppMention(mentionEnvelope);

    const existingHandler = buildHandler({
      reactions: [],
      events: [],
      publisher,
      getOrCreateConversationLinkImpl: async () => ({
        link: {
          id: "link-1",
          workspaceId: "ws-1",
          installationId: "inst-1",
          slackKey: "mention:T1:C1:1700000000.0001",
          conversationId: "conv-1",
        },
        created: false,
      }),
    });
    await existingHandler.handleAppMention({ ...mentionEnvelope, eventId: "Ev-existing" });

    expect(publisher.enqueue).toHaveBeenCalledTimes(1);
    expect(publisher.enqueue).toHaveBeenCalledWith("ws-1", ["conversation.created"]);
  });

  it("swaps the eyes reaction for a failure marker when the reply cannot be delivered", async () => {
    const reactions: ReactionCall[] = [];
    const events: string[] = [];
    const handler = buildHandler({
      reactions,
      events,
      postImpl: async () => {
        throw new Error("post failed");
      },
    });

    await expect(handler.handleAppMention(mentionEnvelope)).rejects.toThrow("post failed");

    expect(reactions).toEqual([
      { op: "add", channel: "C1", timestamp: "1700000000.0001", name: PROCESSING_REACTION },
      { op: "remove", channel: "C1", timestamp: "1700000000.0001", name: PROCESSING_REACTION },
      { op: "add", channel: "C1", timestamp: "1700000000.0001", name: FAILED_REACTION },
    ]);
  });

  it("clears only the processing reaction and marks a superseded event skipped", async () => {
    const reactions: ReactionCall[] = [];
    const events: string[] = [];
    const info = vi.fn();
    const handler = buildHandler({
      reactions,
      events,
      info,
      answerImpl: async () => {
        throw new ChatTurnSupersededError("conv-1", "routing");
      },
    });

    await handler.handleAppMention(mentionEnvelope);

    expect(reactions).toEqual([
      { op: "add", channel: "C1", timestamp: "1700000000.0001", name: PROCESSING_REACTION },
      { op: "remove", channel: "C1", timestamp: "1700000000.0001", name: PROCESSING_REACTION },
    ]);
    expect(events).toEqual(["skipped"]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", eventId: "Ev1", stage: "routing" }),
      "Slack turn superseded",
    );
  });

  it("dispatches concurrent first thread events through one conversation and posts only the newest reply", async () => {
    const reactions: ReactionCall[] = [];
    const events: string[] = [];
    const firstStarted = deferred();
    const newerArrived = deferred();
    const messages: string[] = [];
    const conversationIds: Array<string | undefined> = [];
    const posts: string[] = [];
    let createdConversations = 0;
    let linkedConversationId: string | undefined;
    const handler = buildHandler({
      reactions,
      events,
      getOrCreateConversationLinkImpl: async () => {
        let created = false;
        if (!linkedConversationId) {
          createdConversations += 1;
          linkedConversationId = "conv-shared";
          created = true;
        }
        return {
          link: {
            id: "link-1",
            workspaceId: "ws-1",
            installationId: "inst-1",
            slackKey: "mention:T1:C1:1700000000.0001",
            conversationId: linkedConversationId,
          },
          created,
        };
      },
      answerImpl: async (input) => {
        conversationIds.push(input.conversationId);
        messages.push(input.query);
        if (input.query === "first message") {
          firstStarted.resolve();
          await newerArrived.promise;
          throw new ChatTurnSupersededError(input.conversationId!, "routing");
        }
        newerArrived.resolve();
        return { conversationId: input.conversationId!, answer: "newest reply", outcome: "answered" };
      },
      postImpl: async (input) => {
        posts.push(input.text);
        return { channel: input.channel, ts: "reply-ts" };
      },
    });
    const first = handler.handleAppMention({
      ...mentionEnvelope,
      event: { ...mentionEnvelope.event, text: "first message" },
    });
    await firstStarted.promise;
    const second = handler.handleAppMention({
      ...mentionEnvelope,
      eventId: "Ev2",
      event: { ...mentionEnvelope.event, text: "newest message", ts: "1700000000.0002", thread_ts: "1700000000.0001" },
    });

    await Promise.all([first, second]);

    expect(createdConversations).toBe(1);
    expect(conversationIds).toEqual(["conv-shared", "conv-shared"]);
    expect(messages).toEqual(["first message", "newest message"]);
    expect(posts).toEqual(["newest reply"]);
    expect(events).toEqual(expect.arrayContaining(["skipped", "processed"]));
  });
});
