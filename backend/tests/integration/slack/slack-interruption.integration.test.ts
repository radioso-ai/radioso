import { describe, expect, it, vi } from "vitest";

import type { ChatGateway } from "../../../src/modules/chat/contracts/chatGateway.js";
import type { TurnRouter } from "../../../src/modules/chat/services/turnRouter.js";
import { SlackMessageHandler } from "../../../src/modules/connectors/plugins/slack/slackMessageHandler.js";
import { createConnectorChatPort } from "../../../src/modules/connectors/services/connectorChatPort.js";
import { createTestDependencies } from "../../support/testApp.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("Slack interruption", () => {
  it("persists concurrent first messages in one conversation and posts only the newest eligible reply", async () => {
    const firstRoutingStarted = deferred();
    const releaseFirstRouting = deferred();
    const turnRouter: TurnRouter = {
      async classify(input) {
        if (input.query === "first message") {
          firstRoutingStarted.resolve();
          await releaseFirstRouting.promise;
        }
        return { route: "direct", framing: { isIdentityQuestion: false } };
      },
    };
    const chatGateway: ChatGateway = {
      async answer(input) {
        const earlierUsers = input.history
          .filter((message) => message.role === "user")
          .map((message) => message.content)
          .join(" | ");
        return `latest=${input.query}; history=${earlierUsers}`;
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const ctx = createTestDependencies({ chatGateway, turnRouter });
    const workspace = await ctx.dependencies.workspaceRepository.create("account-1", "Slack interruption workspace");
    const agent = await ctx.dependencies.agentService.resolve(workspace.id);
    const installation = {
      id: "installation-1",
      connectionId: "connection-1",
      workspaceId: workspace.id,
      accountId: "account-1",
      teamId: "T1",
      teamName: "Team",
      botUserId: "UBOT",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    let linkPromise: Promise<{
      id: string;
      workspaceId: string;
      installationId: string;
      slackKey: string;
      conversationId: string;
    }> | undefined;
    const getOrCreateConversationLink = vi.fn(async (input: {
      workspaceId: string;
      installationId: string;
      slackKey: string;
      agentId: string;
      sourceChannel: string;
      channelContext: never;
    }) => {
      const created = linkPromise === undefined;
      linkPromise ??= ctx.repositories.conversationRepository.create(
        input.workspaceId,
        input.agentId,
        input.sourceChannel,
        null,
        null,
        input.channelContext,
      ).then((conversation) => ({
        id: "link-1",
        workspaceId: input.workspaceId,
        installationId: input.installationId,
        slackKey: input.slackKey,
        conversationId: conversation.id,
      }));
      return { link: await linkPromise, created };
    });
    const statuses: Array<{ eventId: string; status: string }> = [];
    const posts: string[] = [];
    const handler = new SlackMessageHandler({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      chat: createConnectorChatPort(ctx.dependencies.chatService),
      installations: { findByTeamId: async () => installation } as never,
      bindings: {
        findAnswerer: async () => ({
          id: "binding-1",
          workspaceId: workspace.id,
          answeringAgentId: agent.id,
          escalationChannelId: null,
          gapEscalationEnabled: false,
        }),
      } as never,
      installationService: {
        resolveBotTokenForInstallation: async () => "xoxb-test",
        markNeedsReauthForInstallation: async () => false,
      },
      persistence: {
        getOrCreateConversationLink,
        markInboundEventStatus: async (eventId: string, status: string) => {
          statuses.push({ eventId, status });
        },
      } as never,
      clientFactory: () => ({
        postMessage: async (input) => {
          posts.push(input.text);
          return { channel: input.channel, ts: "reply-ts" };
        },
        addReaction: async () => undefined,
        removeReaction: async () => undefined,
      }),
    });

    const first = handler.handleMessageIm({
      eventId: "Ev1",
      teamId: "T1",
      event: {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "first message",
      },
    });
    await firstRoutingStarted.promise;
    const latest = handler.handleMessageIm({
      eventId: "Ev2",
      teamId: "T1",
      event: {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "latest message",
      },
    });
    releaseFirstRouting.resolve();

    await Promise.all([first, latest]);

    expect(getOrCreateConversationLink).toHaveBeenCalledTimes(2);
    expect(await ctx.repositories.conversationRepository.countByWorkspaceId(workspace.id)).toBe(1);
    const link = await linkPromise!;
    const messages = await ctx.repositories.messageRepository.listByConversationId(workspace.id, link.conversationId);
    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "first message" },
      { role: "user", content: "latest message" },
      { role: "assistant", content: "latest=latest message; history=first message" },
    ]);
    expect(posts).toEqual(["latest=latest message; history=first message"]);
    expect(statuses).toEqual(expect.arrayContaining([
      { eventId: "Ev1", status: "skipped" },
      { eventId: "Ev2", status: "processed" },
    ]));
  });
});
