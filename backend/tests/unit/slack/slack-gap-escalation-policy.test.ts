import { describe, expect, it, vi } from "vitest";
import type { ConnectorChatPort, ConnectorLogger } from "@radioso/connector-api";

import { SlackMessageHandler } from "../../../src/modules/connectors/plugins/slack/slackMessageHandler.js";
import type {
  SlackBindingRepositoryPort,
  SlackInstallationRecord,
  SlackInstallationRepositoryPort,
  SlackInstallationService,
} from "../../../src/modules/slack/public.js";
import {
  SLACK_MAX_MESSAGE_TEXT_LENGTH as SLACK_TEXT_LIMIT,
  SlackWebApiError,
} from "../../../src/modules/slack/public.js";
import type { SlackPersistencePort } from "../../../src/modules/connectors/plugins/slack/slackPersistence.js";
import type { SlackPostOutboxPort } from "../../../src/modules/slack/public.js";

const installation: SlackInstallationRecord = {
  id: "11111111-1111-1111-1111-111111111111",
  connectionId: "22222222-2222-2222-2222-222222222222",
  workspaceId: "33333333-3333-3333-3333-333333333333",
  teamId: "T1",
  teamName: "Acme",
  botUserId: "UBOT",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const logger: ConnectorLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const basePersistence = (): SlackPersistencePort => ({
  createInboundEvent: vi.fn(),
  markInboundEventStatus: vi.fn(),
  markStaleInboundEventsFailed: vi.fn(async () => 0),
  findConversationLink: vi.fn(async () => null),
  upsertConversationLink: vi.fn(),
});

const makeHandler = (input: {
  outcome: "answered" | "no_context";
  answer?: string;
  escalationChannelId?: string | null;
  outbox?: SlackPostOutboxPort;
}) => {
  const chat: ConnectorChatPort = {
    answer: vi.fn(async () => ({
      conversationId: "44444444-4444-4444-4444-444444444444",
      answer: input.answer ?? "I cannot find that in the docs.",
      outcome: input.outcome,
    })),
  };
  const installations: SlackInstallationRepositoryPort = {
    findById: vi.fn(async () => installation),
    findByTeamId: vi.fn(async () => installation),
    findByWorkspaceId: vi.fn(async () => installation),
    upsert: vi.fn(),
    removeByWorkspaceId: vi.fn(),
  };
  const bindings: SlackBindingRepositoryPort = {
    findByInstallationId: vi.fn(async () => ({
      id: "55555555-5555-5555-5555-555555555555",
      installationId: installation.id,
      workspaceId: installation.workspaceId,
      answeringAgentId: "66666666-6666-6666-6666-666666666666",
      escalationChannelId: input.escalationChannelId === undefined ? "CSUPPORT" : input.escalationChannelId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    upsert: vi.fn(),
    removeByInstallationId: vi.fn(),
  };
  const markNeedsReauthForInstallation = vi.fn(async () => true);
  const installationService: Pick<SlackInstallationService, "markNeedsReauthForInstallation" | "resolveBotTokenForInstallation"> = {
    markNeedsReauthForInstallation,
    resolveBotTokenForInstallation: vi.fn(async () => "xoxb-token"),
  };
  const posted = vi.fn();
  const outbox = input.outbox ?? { enqueue: vi.fn(async () => ({ id: "action-1", duplicate: false })) };
  return {
    chat,
    outbox,
    posted,
    handler: new SlackMessageHandler({
      logger,
      chat,
      installations,
      bindings,
      installationService,
      persistence: basePersistence(),
      slackPostOutbox: outbox,
      clientFactory: () => ({ postMessage: posted }),
    }),
    installationService,
  };
};

const event = {
  eventId: "EvGap",
  teamId: "T1",
  event: {
    type: "message" as const,
    channel_type: "im" as const,
    channel: "D1",
    user: "U1",
    text: "Unsupported question",
  },
};

describe("Slack gap escalation policy", () => {
  it("enqueues slack.post for typed no_context outcome without parsing answer text", async () => {
    const { chat, handler, outbox } = makeHandler({
      outcome: "no_context",
      answer: "Here is a totally confident answer that should not matter.",
    });

    await handler.handleMessageIm(event);

    expect(chat.answer).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "66666666-6666-6666-6666-666666666666",
      workspaceId: installation.workspaceId,
      sourceChannel: "slack",
      channelContext: {
        provider: "slack",
        team: { id: "T1", name: "Acme" },
        channel: { id: "D1", type: "im" },
        user: { id: "U1" },
      },
    }));
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: "slack.post",
      idempotencyKey: "slack:gap_escalation:EvGap:44444444-4444-4444-4444-444444444444",
      payload: expect.objectContaining({
        kind: "gap_escalation",
        installationId: installation.id,
        channelId: "CSUPPORT",
      }),
    }));
  });

  it("does not escalate a grounded turn even when answer text looks like a gap", async () => {
    const { handler, outbox } = makeHandler({
      outcome: "answered",
      answer: "I do not have enough context to answer.",
    });

    await handler.handleMessageIm(event);

    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it("does nothing when no escalation channel is configured", async () => {
    const { handler, outbox } = makeHandler({
      outcome: "no_context",
      escalationChannelId: null,
    });

    await handler.handleMessageIm(event);

    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it("handles app mentions in the originating thread and reuses a thread-scoped conversation", async () => {
    const persistence = basePersistence();
    vi.mocked(persistence.findConversationLink).mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "77777777-7777-7777-7777-777777777777",
      workspaceId: installation.workspaceId,
      installationId: installation.id,
      slackKey: "mention:T1:CCHANNEL:1700000000.000100",
      conversationId: "44444444-4444-4444-4444-444444444444",
    });
    const chat: ConnectorChatPort = {
      answer: vi.fn(async (input) => ({
        conversationId: input.conversationId ?? "44444444-4444-4444-4444-444444444444",
        answer: "Mention reply",
        outcome: "answered" as const,
      })),
    };
    const installations: SlackInstallationRepositoryPort = {
      findById: vi.fn(async () => installation),
      findByTeamId: vi.fn(async () => installation),
      findByWorkspaceId: vi.fn(async () => installation),
      upsert: vi.fn(),
      removeByWorkspaceId: vi.fn(),
    };
    const bindings: SlackBindingRepositoryPort = {
      findByInstallationId: vi.fn(async () => ({
        id: "55555555-5555-5555-5555-555555555555",
        installationId: installation.id,
        workspaceId: installation.workspaceId,
        answeringAgentId: "66666666-6666-6666-6666-666666666666",
        escalationChannelId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      upsert: vi.fn(),
      removeByInstallationId: vi.fn(),
    };
    const installationService: Pick<SlackInstallationService, "markNeedsReauthForInstallation" | "resolveBotTokenForInstallation"> = {
      markNeedsReauthForInstallation: vi.fn(async () => true),
      resolveBotTokenForInstallation: vi.fn(async () => "xoxb-token"),
    };
    const posted = vi.fn();
    const handler = new SlackMessageHandler({
      logger,
      chat,
      installations,
      bindings,
      installationService,
      persistence,
      clientFactory: () => ({ postMessage: posted }),
    });
    const mentionEvent = {
      eventId: "EvMentionOne",
      teamId: "T1",
      event: {
        type: "app_mention" as const,
        channel: "CCHANNEL",
        user: "U1",
        text: "<@UBOT> please help",
        ts: "1700000000.000100",
      },
    };

    await handler.handleAppMention(mentionEvent);
    await handler.handleAppMention({
      ...mentionEvent,
      eventId: "EvMentionTwo",
      event: {
        ...mentionEvent.event,
        text: "<@UBOT> follow up",
        thread_ts: "1700000000.000100",
        ts: "1700000001.000100",
      },
    });

    expect(persistence.upsertConversationLink).toHaveBeenCalledWith(expect.objectContaining({
      slackKey: "mention:T1:CCHANNEL:1700000000.000100",
      conversationId: "44444444-4444-4444-4444-444444444444",
    }));
    expect(chat.answer).toHaveBeenLastCalledWith(expect.objectContaining({
      conversationId: "44444444-4444-4444-4444-444444444444",
      query: "<@UBOT> follow up",
      sourceChannel: "slack",
      channelContext: {
        provider: "slack",
        team: { id: "T1", name: "Acme" },
        channel: { id: "CCHANNEL", type: "channel" },
        threadTs: "1700000000.000100",
        user: { id: "U1" },
      },
    }));
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({
      channel: "CCHANNEL",
      text: "Mention reply",
      threadTs: "1700000000.000100",
    }));
  });

  it("splits long direct Slack replies into bounded messages", async () => {
    const { handler, posted } = makeHandler({
      outcome: "answered",
      answer: `${"a".repeat(SLACK_TEXT_LIMIT)}tail`,
    });

    await handler.handleMessageIm(event);

    expect(posted).toHaveBeenCalledTimes(2);
    expect(posted.mock.calls[0]?.[0]).toMatchObject({
      channel: "D1",
      text: "a".repeat(SLACK_TEXT_LIMIT),
    });
    expect(posted.mock.calls[1]?.[0]).toMatchObject({
      channel: "D1",
      text: "tail",
    });
  });

  it("marks the installation needs_reauth when Slack rejects the direct reply token", async () => {
    const { handler, installationService, posted } = makeHandler({
      outcome: "answered",
      answer: "reply",
    });
    posted.mockImplementation(async () => {
      throw new SlackWebApiError("invalid_auth", "Slack token is invalid");
    });

    await expect(handler.handleMessageIm(event)).rejects.toThrow("Slack token is invalid");

    expect(installationService.markNeedsReauthForInstallation).toHaveBeenCalledWith(installation, "invalid_auth");
  });
});
