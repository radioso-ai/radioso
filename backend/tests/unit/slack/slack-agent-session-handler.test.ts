import { describe, expect, it, vi } from "vitest";
import type { ConnectorChatPort, ConnectorLogger } from "@radioso/connector-api";

import {
  SlackMessageHandler,
  type SlackAppHomeOpenedEvent,
  type SlackMessageImEvent,
} from "../../../src/modules/connectors/plugins/slack/slackMessageHandler.js";
import type { SlackStarterPromptsPort } from "../../../src/modules/connectors/plugins/slack/slackAgentSession.js";
import {
  sessionTitleFromMessage,
  toSuggestedPrompts,
} from "../../../src/modules/connectors/plugins/slack/slackAgentSession.js";
import { ChatTurnSupersededError } from "../../../src/modules/chat/services/conversationTurnRegistry.js";
import {
  SlackWebApiError,
  type SlackInstallationRecord,
  type SlackInstallationRepositoryPort,
  type SlackInstallationService,
} from "../../../src/modules/slack/public.js";
import type { SlackPersistencePort } from "../../../src/modules/connectors/plugins/slack/slackPersistence.js";
import { InMemorySlackBindingRepository } from "../../support/inMemorySlack.js";

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
const CONVERSATION_ID = "44444444-4444-4444-4444-444444444444";

type ClientCall =
  | { op: "post"; channel: string; threadTs?: string; markdownText: string }
  | { op: "reaction"; action: "add" | "remove"; name: string }
  | { op: "status"; channelId: string; threadTs: string; status: string }
  | { op: "rename"; channelId: string; threadTs: string; title: string }
  | { op: "prompts"; input: unknown };

const makeHandler = (options: {
  linkCreated?: boolean;
  answerImpl?: ConnectorChatPort["answer"];
  statusImpl?: () => Promise<void>;
  promptsImpl?: () => Promise<void>;
  starterPrompts?: SlackStarterPromptsPort;
  withoutStarterPrompts?: boolean;
} = {}) => {
  const calls: ClientCall[] = [];
  const statuses: string[] = [];
  const info = vi.fn();
  const warn = vi.fn();
  const logger: ConnectorLogger = { info, warn, error: vi.fn() };
  const bindings = new InMemorySlackBindingRepository();
  const chat: ConnectorChatPort = {
    answer: options.answerImpl ?? vi.fn(async () => ({
      conversationId: CONVERSATION_ID,
      answer: "**bold** answer",
      outcome: "answered" as const,
    })),
  };
  const installations: SlackInstallationRepositoryPort = {
    findById: vi.fn(async () => installation),
    findByTeamId: vi.fn(async () => installation),
    findByWorkspaceId: vi.fn(async () => installation),
    findByAccountId: vi.fn(async () => installation),
    upsert: vi.fn(),
    removeByWorkspaceId: vi.fn(),
  };
  const persistence: SlackPersistencePort = {
    createInboundEvent: vi.fn(),
    markInboundEventStatus: vi.fn(async (_eventId, status) => {
      statuses.push(status);
    }),
    markStaleInboundEventsFailed: vi.fn(async () => 0),
    findConversationLink: vi.fn(async () => null),
    findConversationLinkByConversationId: vi.fn(async () => null),
    getOrCreateConversationLink: vi.fn(async (input) => ({
      link: {
        id: "55555555-5555-4555-8555-555555555555",
        workspaceId: input.workspaceId,
        installationId: input.installationId,
        slackKey: input.slackKey,
        conversationId: CONVERSATION_ID,
      },
      created: options.linkCreated ?? false,
    })),
    upsertConversationLink: vi.fn(),
  };
  const installationService: Pick<SlackInstallationService, "markNeedsReauthForInstallation" | "resolveBotTokenForInstallation"> = {
    markNeedsReauthForInstallation: vi.fn(async () => true),
    resolveBotTokenForInstallation: vi.fn(async () => "xoxb-token"),
  };
  const starterPrompts: SlackStarterPromptsPort = options.starterPrompts ?? {
    listStarterPrompts: vi.fn(async () => []),
  };
  const handler = new SlackMessageHandler({
    logger,
    chat,
    installations,
    bindings,
    installationService,
    persistence,
    ...(options.withoutStarterPrompts ? {} : { starterPrompts }),
    clientFactory: () => ({
      postMessage: async (input) => {
        calls.push({
          op: "post",
          channel: input.channel,
          ...(input.threadTs ? { threadTs: input.threadTs } : {}),
          markdownText: "markdownText" in input ? input.markdownText : input.text,
        });
        return { channel: input.channel, ts: "reply-ts" };
      },
      addReaction: async (input) => {
        calls.push({ op: "reaction", action: "add", name: input.name });
      },
      removeReaction: async (input) => {
        calls.push({ op: "reaction", action: "remove", name: input.name });
      },
      setAgentSessionStatus: async (input) => {
        calls.push({ op: "status", ...input });
        await options.statusImpl?.();
      },
      renameAgentSession: async (input) => {
        calls.push({ op: "rename", ...input });
      },
      setSuggestedPrompts: async (input) => {
        calls.push({ op: "prompts", input });
        await options.promptsImpl?.();
      },
    }),
  });
  return { handler, bindings, calls, statuses, persistence, info, warn, starterPrompts, installationService };
};

const seedDefaultBinding = (bindings: InMemorySlackBindingRepository) =>
  bindings.upsert({
    installationId: installation.id,
    workspaceId: installation.workspaceId,
    channelId: null,
    answeringAgentId: AGENT_DEFAULT,
  });

const dm = (overrides: Partial<SlackMessageImEvent> = {}, eventId = "Ev-dm") => ({
  eventId,
  teamId: "T1",
  event: {
    type: "message" as const,
    channel_type: "im" as const,
    channel: "D1",
    user: "U1",
    text: "how do refunds work?",
    ts: "1700000000.000200",
    ...overrides,
  },
});

const session = (overrides: Partial<SlackMessageImEvent> = {}, eventId = "Ev-session") =>
  dm({ thread_ts: "1700000000.000100", ...overrides }, eventId);

const homeOpened = (tab: SlackAppHomeOpenedEvent["tab"], eventId = "Ev-home") => ({
  eventId,
  teamId: "T1",
  event: { type: "app_home_opened" as const, user: "U1", channel: "D1", tab },
});

describe("SlackMessageHandler agent sessions (DM threads)", () => {
  it("keys a DM session by its thread, replies in it, and shows session status instead of reactions", async () => {
    const { handler, bindings, calls, statuses, persistence, info } = makeHandler();
    await seedDefaultBinding(bindings);

    await handler.handleMessageIm(session());

    expect(persistence.getOrCreateConversationLink).toHaveBeenCalledWith(expect.objectContaining({
      slackKey: "mention:T1:D1:1700000000.000100",
      agentId: AGENT_DEFAULT,
      channelContext: expect.objectContaining({
        channel: { id: "D1", type: "im" },
        threadTs: "1700000000.000100",
        user: { id: "U1" },
      }),
    }));
    expect(calls).toEqual([
      { op: "status", channelId: "D1", threadTs: "1700000000.000100", status: "processing" },
      { op: "post", channel: "D1", threadTs: "1700000000.000100", markdownText: "**bold** answer" },
      { op: "status", channelId: "D1", threadTs: "1700000000.000100", status: "active" },
    ]);
    expect(statuses).toEqual(["processed"]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "Ev-session", surface: "dm_session" }),
      "Slack reply delivered",
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain("refunds");
  });

  it("keeps a top-level DM on the per-user key with reactions and no session calls", async () => {
    const { handler, bindings, calls, persistence, info } = makeHandler();
    await seedDefaultBinding(bindings);

    await handler.handleMessageIm(dm());

    expect(persistence.getOrCreateConversationLink).toHaveBeenCalledWith(expect.objectContaining({
      slackKey: "dm:T1:U1",
      channelContext: expect.not.objectContaining({ threadTs: expect.anything() }),
    }));
    expect(calls).toEqual([
      { op: "reaction", action: "add", name: "eyes" },
      { op: "post", channel: "D1", markdownText: "**bold** answer" },
      { op: "reaction", action: "remove", name: "eyes" },
      { op: "reaction", action: "add", name: "white_check_mark" },
    ]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "Ev-dm", surface: "dm" }),
      "Slack turn dispatch started",
    );
  });

  it("returns the session to active when the turn throws", async () => {
    const { handler, bindings, calls } = makeHandler({
      answerImpl: async () => {
        throw new Error("chat_unavailable");
      },
    });
    await seedDefaultBinding(bindings);

    await expect(handler.handleMessageIm(session())).rejects.toThrow("chat_unavailable");

    expect(calls).toEqual([
      { op: "status", channelId: "D1", threadTs: "1700000000.000100", status: "processing" },
      { op: "status", channelId: "D1", threadTs: "1700000000.000100", status: "active" },
    ]);
  });

  it("returns the session to active when the turn is superseded", async () => {
    const { handler, bindings, calls, statuses } = makeHandler({
      answerImpl: async () => {
        throw new ChatTurnSupersededError(CONVERSATION_ID, "routing");
      },
    });
    await seedDefaultBinding(bindings);

    await handler.handleMessageIm(session());

    expect(calls).toEqual([
      { op: "status", channelId: "D1", threadTs: "1700000000.000100", status: "processing" },
      { op: "status", channelId: "D1", threadTs: "1700000000.000100", status: "active" },
    ]);
    expect(statuses).toEqual(["skipped"]);
  });

  it("titles a new session with the user's first words after the answer posts", async () => {
    const { handler, bindings, calls } = makeHandler({ linkCreated: true });
    await seedDefaultBinding(bindings);

    await handler.handleMessageIm(session({
      text: "Can I return a jacket\nafter 30 days if I still have the receipt and the tags are attached?",
    }));

    expect(calls.map((call) => call.op)).toEqual(["status", "post", "status", "rename"]);
    expect(calls.at(-1)).toEqual({
      op: "rename",
      channelId: "D1",
      threadTs: "1700000000.000100",
      title: "Can I return a jacket after 30 days if I still have the rece…",
    });
  });

  it("leaves the title alone on later turns of an existing session", async () => {
    const { handler, bindings, calls } = makeHandler({ linkCreated: false });
    await seedDefaultBinding(bindings);

    await handler.handleMessageIm(session());

    expect(calls.some((call) => call.op === "rename")).toBe(false);
  });

  it("never lets a status failure fail the turn and logs only the Slack error code", async () => {
    const { handler, bindings, calls, statuses, warn } = makeHandler({
      statusImpl: async () => {
        throw new SlackWebApiError("missing_scope", "Slack Web API returned ok:false: missing_scope");
      },
    });
    await seedDefaultBinding(bindings);

    await handler.handleMessageIm(session());

    expect(calls.filter((call) => call.op === "post")).toHaveLength(1);
    expect(statuses).toEqual(["processed"]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "Ev-session", slackErrorCode: "missing_scope" }),
      expect.any(String),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("refunds");
  });
});

describe("SlackMessageHandler.handleAppHomeOpened", () => {
  it("ignores tabs other than Messages", async () => {
    const { handler, bindings, calls, statuses, starterPrompts } = makeHandler();
    await seedDefaultBinding(bindings);

    await handler.handleAppHomeOpened(homeOpened("home"));

    expect(starterPrompts.listStarterPrompts).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(statuses).toEqual(["skipped"]);
  });

  it("makes no Slack call when the default agent has no starter prompts", async () => {
    const { handler, bindings, calls, statuses, starterPrompts } = makeHandler();
    await seedDefaultBinding(bindings);

    await handler.handleAppHomeOpened(homeOpened("messages"));

    expect(starterPrompts.listStarterPrompts).toHaveBeenCalledWith({
      workspaceId: installation.workspaceId,
      agentId: AGENT_DEFAULT,
    });
    expect(calls).toEqual([]);
    expect(statuses).toEqual(["skipped"]);
  });

  it("sets at most four suggested prompts from the agent's greeting chips, without a thread", async () => {
    const { handler, bindings, calls, statuses } = makeHandler({
      starterPrompts: {
        listStarterPrompts: vi.fn(async () => [
          { label: "Refund policy" },
          { label: "Shipping times" },
          { label: "Track my order" },
          { label: `${"Warranty ".repeat(8)}details` },
          { label: "Fifth chip" },
        ]),
      },
    });
    await seedDefaultBinding(bindings);

    await handler.handleAppHomeOpened(homeOpened("messages"));

    expect(calls).toEqual([{
      op: "prompts",
      input: {
        channelId: "D1",
        prompts: [
          { title: "Refund policy", message: "Refund policy" },
          { title: "Shipping times", message: "Shipping times" },
          { title: "Track my order", message: "Track my order" },
          { title: `${"Warranty ".repeat(6)}Warran…`, message: `${"Warranty ".repeat(8)}details` },
        ],
      },
    }]);
    expect(statuses).toEqual(["processed"]);
  });

  it("marks the install needs_reauth when Slack rejects the prompts with an auth error", async () => {
    const { handler, bindings, statuses, warn, installationService } = makeHandler({
      starterPrompts: { listStarterPrompts: vi.fn(async () => [{ label: "Refund policy" }]) },
      promptsImpl: async () => {
        throw new SlackWebApiError("token_revoked", "Slack Web API returned ok:false: token_revoked");
      },
    });
    await seedDefaultBinding(bindings);

    await handler.handleAppHomeOpened(homeOpened("messages"));

    expect(installationService.markNeedsReauthForInstallation).toHaveBeenCalledWith(installation, "token_revoked");
    expect(statuses).toEqual(["failed"]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "Ev-home", slackErrorCode: "token_revoked" }),
      expect.any(String),
    );
  });

  it("keeps a missing-scope failure as a warning without touching the install status", async () => {
    const { handler, bindings, statuses, installationService } = makeHandler({
      starterPrompts: { listStarterPrompts: vi.fn(async () => [{ label: "Refund policy" }]) },
      promptsImpl: async () => {
        throw new SlackWebApiError("missing_scope", "Slack Web API returned ok:false: missing_scope");
      },
    });
    await seedDefaultBinding(bindings);

    await handler.handleAppHomeOpened(homeOpened("messages"));

    expect(installationService.markNeedsReauthForInstallation).not.toHaveBeenCalled();
    expect(statuses).toEqual(["failed"]);
  });

  it("skips quietly when no starter-prompt source is wired", async () => {
    const { handler, bindings, calls, statuses } = makeHandler({ withoutStarterPrompts: true });
    await seedDefaultBinding(bindings);

    await handler.handleAppHomeOpened(homeOpened("messages"));

    expect(calls).toEqual([]);
    expect(statuses).toEqual(["skipped"]);
  });
});

describe("Slack agent session helpers", () => {
  it("collapses a message to one line and truncates it for a session title", () => {
    expect(sessionTitleFromMessage("  hello\n\n  world  ")).toBe("hello world");
    expect(sessionTitleFromMessage("a".repeat(60))).toBe("a".repeat(60));
    expect(sessionTitleFromMessage("a".repeat(61))).toBe(`${"a".repeat(60)}…`);
  });

  it("maps chip labels onto Slack prompt pairs", () => {
    expect(toSuggestedPrompts([{ label: "One" }, { label: "Two" }])).toEqual([
      { title: "One", message: "One" },
      { title: "Two", message: "Two" },
    ]);
    expect(toSuggestedPrompts([])).toEqual([]);
  });
});
