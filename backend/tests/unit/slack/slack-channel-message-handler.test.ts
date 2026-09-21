import { describe, expect, it, vi } from "vitest";
import type { ConnectorChatPort, ConnectorLogger } from "@radioso/connector-api";

import {
  SlackMessageHandler,
  type SlackChannelMessageEvent,
} from "../../../src/modules/connectors/plugins/slack/slackMessageHandler.js";
import type {
  SlackInstallationRecord,
  SlackInstallationRepositoryPort,
  SlackInstallationService,
} from "../../../src/modules/slack/public.js";
import type {
  SlackConversationLinkRecord,
  SlackPersistencePort,
} from "../../../src/modules/connectors/plugins/slack/slackPersistence.js";
import { InMemorySlackBindingRepository, idleSlackAgentSessionClient } from "../../support/inMemorySlack.js";

const installation: SlackInstallationRecord = {
  id: "11111111-1111-1111-1111-111111111111",
  connectionId: "22222222-2222-2222-2222-222222222222",
  workspaceId: "33333333-3333-3333-3333-333333333333",
  accountId: "99999999-9999-4999-8999-999999999999",
  teamId: "T1",
  teamName: "Acme",
  botUserId: "UBOT",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const AGENT_DEFAULT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AGENT_SALES = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CONVERSATION_ID = "44444444-4444-4444-4444-444444444444";

const seededBindings = async (salesRespondMode: "mention" | "every_message") => {
  const bindings = new InMemorySlackBindingRepository();
  await bindings.upsert({
    installationId: installation.id,
    workspaceId: installation.workspaceId,
    channelId: null,
    answeringAgentId: AGENT_DEFAULT,
  });
  await bindings.upsert({
    installationId: installation.id,
    workspaceId: installation.workspaceId,
    channelId: "CSALES",
    answeringAgentId: AGENT_SALES,
    respondMode: salesRespondMode,
  });
  return bindings;
};

interface PostedMessage {
  channel: string;
  threadTs?: string;
  markdownText?: string;
  text?: string;
}

const makeHandler = (
  bindings: InMemorySlackBindingRepository,
  options: { ownedThreadKeys?: string[]; answerText?: string } = {},
) => {
  const posted: PostedMessage[] = [];
  const answered: Array<{ agentId: string; query: string }> = [];
  const statuses: Array<{ eventId: string; status: string }> = [];
  const reactions: string[] = [];
  const order: string[] = [];
  const info = vi.fn();
  const logger: ConnectorLogger = { info, warn: vi.fn(), error: vi.fn() };
  const chat: ConnectorChatPort = {
    answer: vi.fn(async (req) => {
      answered.push({ agentId: req.agentId, query: req.query });
      return { conversationId: CONVERSATION_ID, answer: options.answerText ?? "**bold** answer", outcome: "answered" as const };
    }),
  };
  const installations: SlackInstallationRepositoryPort = {
    findById: vi.fn(async () => installation),
    findByTeamId: vi.fn(async () => installation),
    findByWorkspaceId: vi.fn(async () => installation),
    findByAccountId: vi.fn(async () => installation),
    upsert: vi.fn(),
    removeByWorkspaceId: vi.fn(),
  };
  const ownedThreadKeys = new Set(options.ownedThreadKeys ?? []);
  const linkFor = (input: { workspaceId: string; installationId?: string; slackKey: string }): SlackConversationLinkRecord => ({
    id: "55555555-5555-4555-8555-555555555555",
    workspaceId: input.workspaceId,
    installationId: input.installationId ?? installation.id,
    slackKey: input.slackKey,
    conversationId: CONVERSATION_ID,
  });
  const persistence: SlackPersistencePort = {
    createInboundEvent: vi.fn(),
    markInboundEventStatus: vi.fn(async (eventId, status) => {
      statuses.push({ eventId, status });
    }),
    markStaleInboundEventsFailed: vi.fn(async () => 0),
    findConversationLink: vi.fn(async (input) => (ownedThreadKeys.has(input.slackKey) ? linkFor(input) : null)),
    findConversationLinkByConversationId: vi.fn(async () => null),
    getOrCreateConversationLink: vi.fn(async (input) => {
      order.push("link");
      return { link: linkFor(input), created: false };
    }),
    upsertConversationLink: vi.fn(),
  };
  const installationService: Pick<SlackInstallationService, "markNeedsReauthForInstallation" | "resolveBotTokenForInstallation"> = {
    markNeedsReauthForInstallation: vi.fn(async () => true),
    resolveBotTokenForInstallation: vi.fn(async () => "xoxb-token"),
  };
  const handler = new SlackMessageHandler({
    logger,
    chat,
    installations,
    bindings,
    installationService,
    persistence,
    clientFactory: () => ({
      postMessage: vi.fn(async (input: PostedMessage) => {
        posted.push(input);
        return { channel: input.channel, ts: "reply-ts" };
      }),
      addReaction: vi.fn(async (input: { name: string }) => {
        order.push(`add_${input.name}`);
        reactions.push(`add_${input.name}`);
      }),
      removeReaction: vi.fn(async (input: { name: string }) => {
        reactions.push(`remove_${input.name}`);
      }),
      ...idleSlackAgentSessionClient(),
    }),
  });
  return { handler, posted, answered, statuses, persistence, info, reactions, order };
};

const channelMessage = (
  overrides: Partial<SlackChannelMessageEvent> & { eventId?: string } = {},
) => {
  const { eventId, ...eventOverrides } = overrides;
  return {
    eventId: eventId ?? "Ev-channel",
    teamId: "T1",
    event: {
      type: "message" as const,
      channel_type: "channel" as const,
      channel: "CSALES",
      user: "U1",
      text: "how do refunds work?",
      ts: "1700000000.000300",
      ...eventOverrides,
    },
  };
};

describe("SlackMessageHandler.handleChannelMessage", () => {
  it("answers an un-mentioned thread reply in a thread Radioso already owns", async () => {
    const { handler, answered, posted, persistence } = makeHandler(await seededBindings("mention"), {
      ownedThreadKeys: ["mention:T1:CSALES:1700000000.000100"],
    });

    await handler.handleChannelMessage(channelMessage({ thread_ts: "1700000000.000100" }));

    expect(answered).toEqual([{ agentId: AGENT_SALES, query: "how do refunds work?" }]);
    expect(persistence.getOrCreateConversationLink).toHaveBeenCalledWith(expect.objectContaining({
      slackKey: "mention:T1:CSALES:1700000000.000100",
      agentId: AGENT_SALES,
      channelContext: expect.objectContaining({
        channel: { id: "CSALES", type: "channel" },
        threadTs: "1700000000.000100",
      }),
    }));
    expect(posted).toEqual([{ channel: "CSALES", threadTs: "1700000000.000100", markdownText: "**bold** answer" }]);
  });

  it("answers a thread the default binding owns in an unbound channel", async () => {
    const { handler, answered } = makeHandler(await seededBindings("mention"), {
      ownedThreadKeys: ["mention:T1:CRANDOM:1700000000.000100"],
    });

    await handler.handleChannelMessage(channelMessage({ channel: "CRANDOM", thread_ts: "1700000000.000100" }));

    expect(answered).toEqual([{ agentId: AGENT_DEFAULT, query: "how do refunds work?" }]);
  });

  it("skips a thread reply in a thread Radioso does not own without logging a line for it", async () => {
    const { handler, answered, statuses, info } = makeHandler(await seededBindings("every_message"));

    await handler.handleChannelMessage(channelMessage({ thread_ts: "1700000000.000100" }));

    expect(answered).toEqual([]);
    expect(statuses).toEqual([{ eventId: "Ev-channel", status: "skipped" }]);
    expect(info).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "thread_not_owned" }),
      expect.anything(),
    );
  });

  it("answers every top-level message in a new thread when the channel binding says so", async () => {
    const { handler, answered, posted, persistence } = makeHandler(await seededBindings("every_message"));

    await handler.handleChannelMessage(channelMessage());

    expect(answered).toEqual([{ agentId: AGENT_SALES, query: "how do refunds work?" }]);
    expect(persistence.findConversationLink).not.toHaveBeenCalled();
    expect(persistence.getOrCreateConversationLink).toHaveBeenCalledWith(expect.objectContaining({
      slackKey: "mention:T1:CSALES:1700000000.000300",
      channelContext: expect.objectContaining({ threadTs: "1700000000.000300" }),
    }));
    expect(posted).toEqual([{ channel: "CSALES", threadTs: "1700000000.000300", markdownText: "**bold** answer" }]);
  });

  it("skips a top-level message in a mention-only bound channel", async () => {
    const { handler, answered, statuses, info } = makeHandler(await seededBindings("mention"));

    await handler.handleChannelMessage(channelMessage());

    expect(answered).toEqual([]);
    expect(statuses).toEqual([{ eventId: "Ev-channel", status: "skipped" }]);
    // The common case in every joined channel: skipped silently, not logged per message.
    expect(info).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "mention_only" }),
      expect.any(String),
    );
  });

  it("claims the thread conversation before signalling work, so a fast follow-up sees the link", async () => {
    const { handler, order } = makeHandler(await seededBindings("every_message"));

    await handler.handleChannelMessage(channelMessage());

    expect(order.slice(0, 2)).toEqual(["link", "add_eyes"]);
  });

  it("stays quiet when the turn returns no reply, such as a thread a person has taken over", async () => {
    const { handler, posted, statuses, reactions, info } = makeHandler(await seededBindings("mention"), {
      ownedThreadKeys: ["mention:T1:CSALES:1700000000.000100"],
      answerText: "   ",
    });

    await handler.handleChannelMessage(channelMessage({ thread_ts: "1700000000.000100" }));

    expect(posted).toEqual([]);
    expect(reactions).toEqual(["add_eyes", "remove_eyes"]);
    expect(statuses).toEqual([{ eventId: "Ev-channel", status: "processed" }]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "Ev-channel", reason: "empty_answer" }),
      expect.any(String),
    );
  });

  it("skips a top-level message in an unbound channel served by the default binding", async () => {
    const { handler, answered, statuses } = makeHandler(await seededBindings("every_message"));

    await handler.handleChannelMessage(channelMessage({ channel: "CRANDOM" }));

    expect(answered).toEqual([]);
    expect(statuses).toEqual([{ eventId: "Ev-channel", status: "skipped" }]);
  });

  it("leaves a message that mentions the bot to the app_mention path", async () => {
    const { handler, answered, statuses, persistence, info } = makeHandler(await seededBindings("every_message"), {
      ownedThreadKeys: ["mention:T1:CSALES:1700000000.000100"],
    });

    await handler.handleChannelMessage(channelMessage({ text: "<@UBOT> hello", thread_ts: "1700000000.000100" }));
    await handler.handleChannelMessage(channelMessage({ eventId: "Ev-top", text: "hey <@UBOT|radioso> there" }));

    expect(answered).toEqual([]);
    expect(persistence.findConversationLink).not.toHaveBeenCalled();
    expect(statuses).toEqual([
      { eventId: "Ev-channel", status: "skipped" },
      { eventId: "Ev-top", status: "skipped" },
    ]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "Ev-channel", reason: "bot_mentioned" }),
      expect.stringContaining("Slack inbound skipped"),
    );
  });

  it("accepts private-channel (group) messages through the same rules", async () => {
    const { handler, answered } = makeHandler(await seededBindings("every_message"));

    await handler.handleChannelMessage(channelMessage({ channel_type: "group" }));

    expect(answered).toEqual([{ agentId: AGENT_SALES, query: "how do refunds work?" }]);
  });
});

describe("SlackMessageHandler.handleAppMention markdown delivery", () => {
  it("posts the agent answer as Slack markdown in the mention thread", async () => {
    const { handler, posted } = makeHandler(await seededBindings("mention"));

    await handler.handleAppMention({
      eventId: "Ev-mention",
      teamId: "T1",
      event: { type: "app_mention", channel: "CSALES", user: "U1", text: "<@UBOT> hello", ts: "1.1" },
    });

    expect(posted).toEqual([{ channel: "CSALES", threadTs: "1.1", markdownText: "**bold** answer" }]);
  });
});
