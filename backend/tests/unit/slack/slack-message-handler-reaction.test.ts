import { describe, expect, it } from "vitest";

import {
  SlackMessageHandler,
  type SlackAppMentionEvent,
  type SlackInboundEventEnvelope,
} from "../../../src/modules/connectors/plugins/slack/slackMessageHandler.js";

const PROCESSING_REACTION = "eyes";
const ANSWERED_REACTION = "white_check_mark";
const FAILED_REACTION = "x";

interface ReactionCall {
  op: "add" | "remove";
  channel: string;
  timestamp: string;
  name: string;
}

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
  postImpl?: () => Promise<{ channel: string; ts: string }>;
}) => {
  return new SlackMessageHandler({
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
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
      upsertConversationLink: async () => undefined,
    } as never,
    chat: {
      answer: async () => ({ conversationId: "conv-1", answer: "the answer", outcome: "answered" }),
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
});
