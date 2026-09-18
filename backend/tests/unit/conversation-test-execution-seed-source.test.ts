import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import { RETRIEVAL_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";
import {
  ConversationTestExecutionSeedSource,
  type SeedClarificationReaderPort,
  type SeedConversationReaderPort,
  type SeedDirectiveStateReaderPort,
  type SeedMessageReaderPort,
  type SeedRoutineStateReaderPort,
} from "../../src/modules/chat/services/conversationTestExecutionSeedSource.js";

const buildConversation = (overrides: Partial<ConversationRecord> = {}): ConversationRecord => ({
  id: randomUUID(),
  workspaceId: randomUUID(),
  agentId: randomUUID(),
  purpose: "production",
  agentName: null,
  agentInternalName: null,
  sourceChannel: "website_embed",
  sourceOrigin: null,
  channelContext: null,
  anonymousSessionId: null,
  verifiedCustomerId: null,
  entryPageUrl: null,
  title: null,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  ...overrides,
});

const buildMessage = (overrides: Partial<MessageRecord> & Pick<MessageRecord, "role" | "content">): MessageRecord => ({
  id: randomUUID(),
  conversationId: randomUUID(),
  workspaceId: randomUUID(),
  source: undefined,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  ...overrides,
});

describe("ConversationTestExecutionSeedSource", () => {
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();

  let findByIdAndWorkspaceId: ReturnType<typeof vi.fn<SeedConversationReaderPort["findByIdAndWorkspaceId"]>>;
  let listRecentByConversationId: ReturnType<typeof vi.fn<SeedMessageReaderPort["listRecentByConversationId"]>>;
  let loadActive: ReturnType<typeof vi.fn<SeedRoutineStateReaderPort["loadActive"]>>;
  let loadPending: ReturnType<typeof vi.fn<SeedClarificationReaderPort["loadPending"]>>;
  let loadDirectiveState: ReturnType<typeof vi.fn<SeedDirectiveStateReaderPort["load"]>>;
  let source: ConversationTestExecutionSeedSource;

  beforeEach(() => {
    findByIdAndWorkspaceId = vi.fn(async () => buildConversation({ id: conversationId, workspaceId, agentId }));
    listRecentByConversationId = vi.fn(async () => []);
    loadActive = vi.fn(async () => null);
    loadPending = vi.fn(async () => null);
    loadDirectiveState = vi.fn(async () => null);
    source = new ConversationTestExecutionSeedSource({
      conversations: { findByIdAndWorkspaceId },
      messages: { listRecentByConversationId },
      routineStates: { loadActive },
      clarifications: { loadPending },
      directiveStates: { load: loadDirectiveState },
    });
  });

  it("copies only user and assistant messages, in order, and skips system rows", async () => {
    const rows = [
      buildMessage({ id: "s-0", role: "system", content: "system prompt" }),
      buildMessage({ id: "m-1", role: "user", content: "hello", source: "customer", createdAt: new Date(1) }),
      buildMessage({ id: "m-2", role: "assistant", content: "hi there", source: "ai_agent", createdAt: new Date(2) }),
      buildMessage({ id: "s-1", role: "system", content: "mid system" }),
      buildMessage({ id: "m-3", role: "user", content: "another", source: "customer", createdAt: new Date(3) }),
    ];
    listRecentByConversationId.mockResolvedValue(rows);

    const seed = await source.loadSeed({ workspaceId, agentId, conversationId });

    expect(findByIdAndWorkspaceId).toHaveBeenCalledWith(conversationId, workspaceId);
    // The same recent-message window a live turn reads, plus one row to tell a full window
    // from a thread that exactly fits.
    expect(listRecentByConversationId).toHaveBeenCalledWith(workspaceId, conversationId, RETRIEVAL_BEHAVIOR.rewriteConversationContextMaxMessages + 1);
    expect(seed?.messages).toEqual([
      { role: "user", content: "hello", messageId: "m-1", createdAt: new Date(1) },
      { role: "assistant", content: "hi there", messageId: "m-2", createdAt: new Date(2) },
      { role: "user", content: "another", messageId: "m-3", createdAt: new Date(3) },
    ]);
  });

  it("returns an empty thread, not null, when the source has no user or assistant messages", async () => {
    listRecentByConversationId.mockResolvedValue([buildMessage({ role: "system", content: "only scaffolding" })]);

    const seed = await source.loadSeed({ workspaceId, agentId, conversationId });

    expect(seed).not.toBeNull();
    expect(seed?.messages).toEqual([]);
  });

  it("carries the active routine state, pending clarification, and directive state as a v1 continuation", async () => {
    const expiresAt = new Date("2026-06-01T01:00:00.000Z");
    loadActive.mockResolvedValue({
      sessionId: conversationId,
      routineId: "kriya-courses",
      path: ["start", "collect_date"],
      variables: { date: "2026-07" },
      attempts: { collect_date: 1 },
      status: "active",
    });
    loadPending.mockResolvedValue({
      sessionId: conversationId,
      source: "routine",
      candidates: [{ id: "a", label: "Option A", confidence: 1, payload: { route: "a" } }],
      status: "pending",
      expiresAt,
      mode: "ask",
    });
    loadDirectiveState.mockResolvedValue({ turnSeq: 4, firings: { greet: { lastFiredTurn: 1, count: 1 } } });

    const seed = await source.loadSeed({ workspaceId, agentId, conversationId });

    expect(loadActive).toHaveBeenCalledWith({ sessionId: conversationId });
    expect(loadPending).toHaveBeenCalledWith({ sessionId: conversationId });
    expect(loadDirectiveState).toHaveBeenCalledWith({ sessionId: conversationId });
    // The continuation carries no session id: the runner rebinds it to the side's own conversation.
    expect(seed?.continuation).toEqual({
      version: 1,
      routineState: {
        routineId: "kriya-courses",
        path: ["start", "collect_date"],
        variables: { date: "2026-07" },
        attempts: { collect_date: 1 },
        status: "active",
      },
      pendingClarification: {
        source: "routine",
        candidates: [{ id: "a", label: "Option A", confidence: 1, payload: { route: "a" } }],
        status: "pending",
        expiresAt,
        mode: "ask",
      },
      directiveState: { turnSeq: 4, firings: { greet: { lastFiredTurn: 1, count: 1 } } },
    });
  });

  it("leaves the continuation null when the source has no active routine, clarification, or directive memory", async () => {
    const seed = await source.loadSeed({ workspaceId, agentId, conversationId });

    expect(seed?.continuation).toBeNull();
  });

  it("returns null when the conversation is not in the workspace", async () => {
    findByIdAndWorkspaceId.mockResolvedValue(null);

    await expect(source.loadSeed({ workspaceId, agentId, conversationId })).resolves.toBeNull();
    expect(listRecentByConversationId).not.toHaveBeenCalled();
    expect(loadActive).not.toHaveBeenCalled();
  });

  it("returns null when the conversation belongs to a different agent", async () => {
    findByIdAndWorkspaceId.mockResolvedValue(buildConversation({ id: conversationId, workspaceId, agentId: randomUUID() }));

    await expect(source.loadSeed({ workspaceId, agentId, conversationId })).resolves.toBeNull();
    expect(listRecentByConversationId).not.toHaveBeenCalled();
  });

  it("opens a window-cut thread on a user turn rather than an orphan assistant reply", async () => {
    const limit = RETRIEVAL_BEHAVIOR.rewriteConversationContextMaxMessages;
    // An overflowing fetch means older messages were cut, so the oldest fetched row goes and a
    // leading reply that lost its question goes with it.
    const rows = Array.from({ length: limit + 1 }, (_, index) => buildMessage({
      id: `m-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      createdAt: new Date(index),
    }));
    listRecentByConversationId.mockResolvedValue(rows);

    const seed = await source.loadSeed({ workspaceId, agentId, conversationId });

    // m-0 falls outside the window; m-1 is the reply to it, so the thread opens on m-2.
    expect(seed?.messages[0]).toMatchObject({ role: "user", messageId: "m-2" });
    expect(seed?.messages).toHaveLength(limit - 1);
  });

  it("keeps a leading greeting when the thread exactly fills the window", async () => {
    const limit = RETRIEVAL_BEHAVIOR.rewriteConversationContextMaxMessages;
    const rows = Array.from({ length: limit }, (_, index) => buildMessage({
      id: `m-${index}`,
      role: index % 2 === 0 ? "assistant" : "user",
      content: `message ${index}`,
      createdAt: new Date(index),
    }));
    listRecentByConversationId.mockResolvedValue(rows);

    const seed = await source.loadSeed({ workspaceId, agentId, conversationId });

    expect(seed?.messages[0]).toMatchObject({ role: "assistant", messageId: "m-0" });
    expect(seed?.messages).toHaveLength(limit);
  });

  it("keeps a leading greeting when the thread fits inside the window", async () => {
    listRecentByConversationId.mockResolvedValue([
      buildMessage({ id: "g", role: "assistant", content: "Welcome", createdAt: new Date(0) }),
      buildMessage({ id: "u", role: "user", content: "hello", createdAt: new Date(1) }),
    ]);

    const seed = await source.loadSeed({ workspaceId, agentId, conversationId });

    expect(seed?.messages.map((message) => message.messageId)).toEqual(["g", "u"]);
  });
});
