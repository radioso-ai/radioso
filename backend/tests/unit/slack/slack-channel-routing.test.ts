import { describe, expect, it, vi } from "vitest";
import type { ConnectorChatPort, ConnectorLogger } from "@radioso/connector-api";

import { SlackMessageHandler } from "../../../src/modules/connectors/plugins/slack/slackMessageHandler.js";
import type {
  SlackInstallationRecord,
  SlackInstallationRepositoryPort,
  SlackInstallationService,
} from "../../../src/modules/slack/public.js";
import type { SlackPersistencePort } from "../../../src/modules/connectors/plugins/slack/slackPersistence.js";
import { InMemorySlackBindingRepository } from "../../support/inMemorySlack.js";

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

const AGENT_DEFAULT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AGENT_SALES = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const logger: ConnectorLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const seededBindings = async () => {
  const bindings = new InMemorySlackBindingRepository();
  // Default answerer (DMs + unbound channels).
  await bindings.upsert({
    installationId: installation.id,
    workspaceId: installation.workspaceId,
    channelId: null,
    answeringAgentId: AGENT_DEFAULT,
  });
  // Channel-specific override.
  await bindings.upsert({
    installationId: installation.id,
    workspaceId: installation.workspaceId,
    channelId: "CSALES",
    answeringAgentId: AGENT_SALES,
  });
  return bindings;
};

const makeHandler = (bindings: InMemorySlackBindingRepository) => {
  const answeredWith: string[] = [];
  const chat: ConnectorChatPort = {
    answer: vi.fn(async (req) => {
      answeredWith.push(req.agentId);
      return { conversationId: "44444444-4444-4444-4444-444444444444", answer: "ok", outcome: "answered" as const };
    }),
  };
  const installations: SlackInstallationRepositoryPort = {
    findById: vi.fn(async () => installation),
    findByTeamId: vi.fn(async () => installation),
    findByWorkspaceId: vi.fn(async () => installation),
    upsert: vi.fn(),
    removeByWorkspaceId: vi.fn(),
  };
  const persistence: SlackPersistencePort = {
    createInboundEvent: vi.fn(),
    markInboundEventStatus: vi.fn(),
    markStaleInboundEventsFailed: vi.fn(async () => 0),
    findConversationLink: vi.fn(async () => null),
    findConversationLinkByConversationId: vi.fn(async () => null),
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
    clientFactory: () => ({ postMessage: vi.fn(), addReaction: vi.fn(), removeReaction: vi.fn() }),
  });
  return { handler, answeredWith };
};

const mention = (channel: string) => ({
  eventId: `Ev-${channel}`,
  teamId: "T1",
  event: { type: "app_mention" as const, channel, user: "U1", text: "<@UBOT> hello", ts: "1.1" },
});

describe("Slack channel-scoped answerer routing", () => {
  it("routes a mention in a bound channel to that channel's agent", async () => {
    const { handler, answeredWith } = makeHandler(await seededBindings());
    await handler.handleAppMention(mention("CSALES"));
    expect(answeredWith).toEqual([AGENT_SALES]);
  });

  it("falls back to the default agent for a mention in an unbound channel", async () => {
    const { handler, answeredWith } = makeHandler(await seededBindings());
    await handler.handleAppMention(mention("CRANDOM"));
    expect(answeredWith).toEqual([AGENT_DEFAULT]);
  });

  it("routes DMs to the default agent (no routable channel)", async () => {
    const { handler, answeredWith } = makeHandler(await seededBindings());
    await handler.handleMessageIm({
      eventId: "Ev-dm",
      teamId: "T1",
      event: { type: "message", channel_type: "im", channel: "D1", user: "U1", text: "hi" },
    });
    expect(answeredWith).toEqual([AGENT_DEFAULT]);
  });
});

describe("InMemorySlackBindingRepository.findAnswerer", () => {
  it("prefers the channel binding, falls back to the default, and isolates by channel", async () => {
    const bindings = await seededBindings();
    expect((await bindings.findAnswerer(installation.id, "CSALES"))?.answeringAgentId).toBe(AGENT_SALES);
    expect((await bindings.findAnswerer(installation.id, "CRANDOM"))?.answeringAgentId).toBe(AGENT_DEFAULT);
    expect((await bindings.findAnswerer(installation.id, null))?.answeringAgentId).toBe(AGENT_DEFAULT);
    expect((await bindings.findByInstallationId(installation.id))?.answeringAgentId).toBe(AGENT_DEFAULT);
  });
});
