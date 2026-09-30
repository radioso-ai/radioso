import { describe, expect, it } from "vitest";

import {
  presentPublicChatSession,
  stripPublicChatCitationArtifacts,
  stripPublicConversationCitationArtifacts,
  stripPublicConversationTailCitationArtifacts,
  stripPublicStreamCitationArtifacts,
} from "../../src/app/http/presenters/publicChatPresenter.js";
import type {
  ChatConversationDetail,
  ChatConversationTurn,
} from "../../src/modules/chat/services/chatHistoryService.js";
import type { ChatStreamEvent } from "../../src/modules/chat/contracts/index.js";
import type { ConversationAgent } from "../../src/modules/agents/public.js";

const collect = async (events: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> => {
  const collected: ChatStreamEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
};

describe("public chat presenter", () => {
  it("uses the shared agent theme rather than the legacy widget theme", () => {
    const sharedTheme = { brand: "#123456", brandText: "#ffffff", surface: "#f8fafc", text: "#102030" };
    const legacyWidgetTheme = { brand: "#abcdef", brandText: "#111111", surface: "#ffffff", text: "#222222" };
    const agent = {
      id: "agent-1",
      name: "Support",
      theme: sharedTheme,
      surfaceSettings: {
        websiteEmbed: { theme: legacyWidgetTheme, copy: {} },
      },
    } as ConversationAgent;

    const result = presentPublicChatSession({
      agent,
      workspaceName: "Acme",
      publicChatToken: "public-token",
      session: { publicSessionId: "session-1", token: "session-token", expiresAt: "2026-01-01T00:00:00.000Z" },
      resume: { token: "resume-token", expiresAt: "2026-01-01T00:00:00.000Z" },
      assistantAvatarUrl: null,
    });

    expect(result.theme).toEqual(sharedTheme);
  });

  it("strips citation anchors from in-progress public stream chunks", async () => {
    const events = await collect(stripPublicStreamCitationArtifacts((async function* () {
      yield { type: "chunk", text: "Preparation period[[" };
      yield { type: "chunk", text: "9]]. Next " };
      yield { type: "chunk", text: "claim[[10]]." };
    })(), false));

    expect(events).toEqual([
      { type: "chunk", text: "Preparation period" },
      { type: "chunk", text: ". Next" },
      { type: "chunk", text: " claim." },
    ]);
    expect(events.map((event) => event.type === "chunk" ? event.text : "").join("")).toBe(
      "Preparation period. Next claim.",
    );
  });

  const payload = () => ({
    answer: "Grounded answer.",
    citations: [
      { documentId: "doc-1", chunkId: "chunk-1", title: "Policy Handbook", sourceUrl: "https://example.com/policy" },
      { documentId: "doc-2", chunkId: "chunk-2", title: "Internal Memo" },
    ],
    answerSegments: [{ text: "Grounded answer.", citationIndices: [0, 1] }],
  });

  it("hides citations entirely when citation display is disabled", () => {
    const result = stripPublicChatCitationArtifacts(payload(), false) as Record<string, unknown>;

    expect(result.citations).toBeUndefined();
    expect(result.answerSegments).toEqual([{ text: "Grounded answer." }]);
  });

  it("removes coverage diagnostics from public JSON and done events without mutating the operator payload", async () => {
    const operatorPayload = {
      ...payload(),
      answerCoverage: { availability: "assessed", unresolvedRequest: "Private request" },
      interactionTrace: { state: "evaluated", decisions: [{ targetId: "routine-private" }] },
      debug: { answerCoverage: { contextualizedRequest: "Private request" } },
    };
    const json = stripPublicChatCitationArtifacts(operatorPayload, true) as Record<string, unknown>;
    const events = await collect(stripPublicStreamCitationArtifacts((async function* () {
      yield {
        type: "done" as const,
        conversationId: "c1",
        assistantMessageId: "m1",
        route: { type: "retrieval", reason: "evidence_required" },
        activitySummary: {},
        activityTrace: {},
        ...operatorPayload,
      } as unknown as ChatStreamEvent;
    })(), true));

    expect(json).not.toHaveProperty("answerCoverage");
    expect(json).not.toHaveProperty("interactionTrace");
    expect(json).not.toHaveProperty("debug");
    expect(events[0]).not.toHaveProperty("answerCoverage");
    expect(events[0]).not.toHaveProperty("interactionTrace");
    expect(events[0]).not.toHaveProperty("debug");
    expect(operatorPayload.answerCoverage).toEqual(expect.objectContaining({ unresolvedRequest: "Private request" }));
  });

  it("exposes labels and links but never internal identifiers when citation display is enabled", () => {
    const result = stripPublicChatCitationArtifacts(payload(), true) as Record<string, unknown>;

    expect(result.citations).toEqual([
      { documentId: "", chunkId: "", title: "Policy Handbook", sourceUrl: "https://example.com/policy" },
      { documentId: "", chunkId: "", title: "Internal Memo" },
    ]);
    // Segment indices survive so the client can render non-interactive markers.
    expect(result.answerSegments).toEqual([{ text: "Grounded answer.", citationIndices: [0, 1] }]);
  });

  it("never forwards a replier's teammate label to the visitor, even when a read carried one", () => {
    // The public presenters forward unrecognised message fields, so an operator-only field that a
    // mis-wired read attached would otherwise reach the visitor. A teammate label can be an email.
    const reply: ChatConversationTurn = {
      id: "m1",
      role: "assistant",
      source: "human_agent",
      content: "Happy to help.",
      createdAt: "2026-09-30T10:00:00.000Z",
      operatorDisplayName: "Acme Support",
      operatorLabel: "carl@acme.example",
    };
    const tail = stripPublicConversationTailCitationArtifacts({ messages: [reply], cursor: null }, true);
    const detail = stripPublicConversationCitationArtifacts(
      { messages: [reply] } as unknown as ChatConversationDetail,
      "anonymous-session-1",
      true,
    );

    for (const message of [...tail.messages, ...detail.messages]) {
      expect(message).not.toHaveProperty("operatorLabel");
      expect(message).toMatchObject({ operatorDisplayName: "Acme Support" });
    }
  });

  it("never forwards a conversation's ownership to the visitor, AI-owned included, even when a read carried it", () => {
    // Operator reads carry the ownership record whenever one exists; it names the teammate
    // handling the conversation, so a mis-wired read must still not hand it to the visitor.
    const ownership = {
      conversationId: "c1",
      workspaceId: "w1",
      state: "ai_owned" as const,
      ownerAccountId: null,
      ownerUserId: null,
      ownerDisplayName: null,
      reason: "operator_takeover",
      version: 3,
      takenOverAt: null,
      createdAt: "2026-09-30T10:00:00.000Z",
      updatedAt: "2026-09-30T10:00:00.000Z",
    };
    const tail = stripPublicConversationTailCitationArtifacts({ messages: [], cursor: null, ownership }, true);
    const detail = stripPublicConversationCitationArtifacts(
      { messages: [], ownership } as unknown as ChatConversationDetail,
      "anonymous-session-1",
      true,
    );

    expect(tail).not.toHaveProperty("ownership");
    expect(detail).not.toHaveProperty("ownership");
  });

  it("never forwards a conversation's activity to the visitor, even when a read carried it", () => {
    // Operator reads carry who claimed, reassigned, and handed back the conversation, labelled by
    // teammate label (which can be an email), so a mis-wired read must still not hand it on.
    const activity = [{
      id: "a1",
      kind: "reassigned" as const,
      createdAt: "2026-09-30T10:00:00.000Z",
      actor: { userId: "u1", label: "bea@acme.example" },
      subject: { userId: "u2", label: "Carl" },
      from: null,
      handoffReason: null,
      decision: null,
      resolution: null,
      assistantMessageId: null,
    }];
    const tail = stripPublicConversationTailCitationArtifacts({ messages: [], cursor: null, activity }, true);
    const detail = stripPublicConversationCitationArtifacts(
      { messages: [], activity } as unknown as ChatConversationDetail,
      "anonymous-session-1",
      true,
    );

    expect(tail).not.toHaveProperty("activity");
    expect(detail).not.toHaveProperty("activity");
  });
});
