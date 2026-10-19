import { describe, expect, it } from "vitest";

import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { RetrievalTurnPort } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { RetrievalPipelineRequest } from "../../src/modules/retrieval/public.js";
import {
  createAuditService,
  InMemoryAgentRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
  publishedRevisionResolverFixture,
} from "../support/fakes.js";

const retrievalTurnStub: RetrievalTurnPort = {
  async interpret(request: RetrievalPipelineRequest) {
    return {
      request,
      traceStartedAtMs: Date.now(),
      context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
      interpretation: { result: {}, startedAt: Date.now(), durationMs: 0 },
    };
  },
  async dispatch() {
    throw new Error("retrieval is not part of this test");
  },
};

const counted: { name: string; labels: Record<string, string> }[] = [];
const metrics = {
  incrementCounter(name: string, options: { labels?: Record<string, string> }) {
    counted.push({ name, labels: options.labels ?? {} });
  },
};

const setup = async () => {
  counted.length = 0;
  const conversations = new InMemoryConversationRepository();
  const agents = new InMemoryAgentRepository();
  const agent = await agents.create("ws-1", {
    name: "Bot",
    branding: {
      hidePoweredBy: false,
      privacyPolicyUrl: null,
      privacyNotice: {
        en: { text: "We use your messages to answer you.", url: "https://example.com/privacy", version: "" },
        de: { text: "Wir nutzen Ihre Nachrichten.", url: "https://example.com/datenschutz", version: "" },
      },
    },
  });
  const preparer = new ChatSessionPreparer(
    conversations,
    new InMemoryMessageRepository(),
    retrievalTurnStub,
    createAuditService(),
    undefined,
    { async resolve() { return agent; } },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    publishedRevisionResolverFixture(),
    undefined,
    metrics,
  );
  const prepare = (input: { conversationId?: string; privacyNoticeVersion?: string }) => preparer.prepare({
    workspaceId: "ws-1",
    agentId: agent.id,
    query: "Hi",
    chatSessionId: "anon-1",
    sourceChannel: "website_embed",
    ...input,
  }, { skipRetrieval: true });
  return { agent, conversations, prepare };
};

describe("ChatSessionPreparer privacy notice record (#1545)", () => {
  it("records the version a visitor was shown on the conversation their first message starts", async () => {
    const { agent, conversations, prepare } = await setup();
    const shown = agent.branding.privacyNotice.de.version;

    const session = await prepare({ privacyNoticeVersion: shown });

    const stored = await conversations.findByIdAndWorkspaceId(session.conversation.id, "ws-1");
    expect(stored?.privacyNoticeVersion).toBe(shown);
    expect(counted).toContainEqual({ name: "privacy_notice_reports_total", labels: { outcome: "recorded" } });
  });

  it("records nothing for a version the agent's notices do not carry, and counts it", async () => {
    const { conversations, prepare } = await setup();

    const session = await prepare({ privacyNoticeVersion: "en:0000000000000000" });

    expect((await conversations.findByIdAndWorkspaceId(session.conversation.id, "ws-1"))?.privacyNoticeVersion).toBeNull();
    expect(counted).toContainEqual({ name: "privacy_notice_reports_total", labels: { outcome: "unknown_version" } });
  });

  it("leaves a conversation that already started alone: the notice belongs before the first message", async () => {
    const { agent, conversations, prepare } = await setup();
    const first = await prepare({});

    await prepare({ conversationId: first.conversation.id, privacyNoticeVersion: agent.branding.privacyNotice.en.version });

    expect((await conversations.findByIdAndWorkspaceId(first.conversation.id, "ws-1"))?.privacyNoticeVersion).toBeNull();
    expect(counted.filter((entry) => entry.name === "privacy_notice_reports_total")).toEqual([]);
  });
});
