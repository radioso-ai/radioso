import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import {
  ConversationForkService,
  type ForkConversationRepositoryPort,
  type ForkMessageRepositoryPort,
  type ForkRoutineStateRepositoryPort,
} from "../../src/modules/chat/services/conversationForkService.js";

const buildConversation = (overrides: Partial<ConversationRecord> = {}): ConversationRecord => ({
  id: randomUUID(),
  workspaceId: randomUUID(),
  agentId: randomUUID(),
  agentName: null,
  sourceChannel: "website_embed",
  sourceOrigin: null,
  channelContext: null,
  anonymousSessionId: null,
  verifiedCustomerId: null,
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

describe("ConversationForkService", () => {
  const workspaceId = randomUUID();
  const sourceConversationId = randomUUID();
  const sourceAgentId = randomUUID();
  const forkConversationId = randomUUID();

  let findByIdAndWorkspaceId: ReturnType<typeof vi.fn>;
  let createConversation: ReturnType<typeof vi.fn>;
  let listByConversationId: ReturnType<typeof vi.fn>;
  let createMessage: ReturnType<typeof vi.fn>;
  let loadActiveRoutineState: ReturnType<typeof vi.fn>;
  let saveRoutineState: ReturnType<typeof vi.fn>;
  let service: ConversationForkService;

  beforeEach(() => {
    findByIdAndWorkspaceId = vi.fn();
    createConversation = vi.fn();
    listByConversationId = vi.fn();
    createMessage = vi.fn();
    loadActiveRoutineState = vi.fn().mockResolvedValue(null);
    saveRoutineState = vi.fn();

    service = new ConversationForkService(
      { findByIdAndWorkspaceId, create: createConversation } as unknown as ForkConversationRepositoryPort,
      { listByConversationId, create: createMessage } as unknown as ForkMessageRepositoryPort,
      { loadActive: loadActiveRoutineState, save: saveRoutineState } as unknown as ForkRoutineStateRepositoryPort,
    );
  });

  it("creates a test-session fork with the source agent and authenticated_chat channel", async () => {
    findByIdAndWorkspaceId.mockResolvedValue(
      buildConversation({ id: sourceConversationId, workspaceId, agentId: sourceAgentId }),
    );
    listByConversationId.mockResolvedValue([]);
    createConversation.mockResolvedValue(buildConversation({ id: forkConversationId, workspaceId, agentId: sourceAgentId }));

    const result = await service.forkForTest(workspaceId, sourceConversationId);

    expect(createConversation).toHaveBeenCalledWith(workspaceId, sourceAgentId, "authenticated_chat");
    expect(result).toEqual({ conversationId: forkConversationId });
  });

  it("copies only user and assistant messages, in order, into the fork and skips system messages", async () => {
    findByIdAndWorkspaceId.mockResolvedValue(
      buildConversation({ id: sourceConversationId, workspaceId, agentId: sourceAgentId }),
    );
    listByConversationId.mockResolvedValue([
      buildMessage({ role: "system", content: "system prompt" }),
      buildMessage({ role: "user", content: "hello", source: "customer" }),
      buildMessage({ role: "assistant", content: "hi there", source: "ai_agent" }),
      buildMessage({ role: "system", content: "mid system" }),
      buildMessage({ role: "user", content: "another", source: "customer" }),
    ]);
    createConversation.mockResolvedValue(buildConversation({ id: forkConversationId, workspaceId, agentId: sourceAgentId }));
    createMessage.mockImplementation(async (input) => buildMessage({ role: input.role, content: input.content }));

    await service.forkForTest(workspaceId, sourceConversationId);

    const copied = createMessage.mock.calls.map(([input]) => ({
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      source: input.source,
    }));

    expect(copied).toEqual([
      { conversationId: forkConversationId, role: "user", content: "hello", source: "customer" },
      { conversationId: forkConversationId, role: "assistant", content: "hi there", source: "ai_agent" },
      { conversationId: forkConversationId, role: "user", content: "another", source: "customer" },
    ]);
  });

  it("never writes to the source conversation or its messages", async () => {
    findByIdAndWorkspaceId.mockResolvedValue(
      buildConversation({ id: sourceConversationId, workspaceId, agentId: sourceAgentId }),
    );
    listByConversationId.mockResolvedValue([
      buildMessage({ role: "user", content: "hello" }),
      buildMessage({ role: "assistant", content: "hi there" }),
    ]);
    createConversation.mockResolvedValue(buildConversation({ id: forkConversationId, workspaceId, agentId: sourceAgentId }));
    createMessage.mockImplementation(async (input) => buildMessage({ role: input.role, content: input.content }));

    await service.forkForTest(workspaceId, sourceConversationId);

    // Every persisted message targets the fork, never the source conversation.
    for (const [input] of createMessage.mock.calls) {
      expect(input.conversationId).toBe(forkConversationId);
      expect(input.conversationId).not.toBe(sourceConversationId);
    }
  });

  it("copies an active routine state onto the fork, re-keyed to the fork session, so it resumes mid-routine", async () => {
    findByIdAndWorkspaceId.mockResolvedValue(
      buildConversation({ id: sourceConversationId, workspaceId, agentId: sourceAgentId }),
    );
    listByConversationId.mockResolvedValue([]);
    createConversation.mockResolvedValue(buildConversation({ id: forkConversationId, workspaceId, agentId: sourceAgentId }));
    loadActiveRoutineState.mockResolvedValue({
      sessionId: sourceConversationId,
      routineId: "kriya-courses",
      path: ["start", "collect_date"],
      variables: { date: "2026-07" },
      attempts: { collect_date: 1 },
      status: "active",
    });

    await service.forkForTest(workspaceId, sourceConversationId);

    expect(loadActiveRoutineState).toHaveBeenCalledWith({ sessionId: sourceConversationId });
    expect(saveRoutineState).toHaveBeenCalledWith({
      sessionId: forkConversationId,
      routineId: "kriya-courses",
      path: ["start", "collect_date"],
      variables: { date: "2026-07" },
      attempts: { collect_date: 1 },
      status: "active",
    });
  });

  it("does not write routine state when the source has no active routine", async () => {
    findByIdAndWorkspaceId.mockResolvedValue(
      buildConversation({ id: sourceConversationId, workspaceId, agentId: sourceAgentId }),
    );
    listByConversationId.mockResolvedValue([]);
    createConversation.mockResolvedValue(buildConversation({ id: forkConversationId, workspaceId, agentId: sourceAgentId }));
    loadActiveRoutineState.mockResolvedValue(null);

    await service.forkForTest(workspaceId, sourceConversationId);

    expect(saveRoutineState).not.toHaveBeenCalled();
  });

  it("throws when the source conversation is not in the workspace", async () => {
    findByIdAndWorkspaceId.mockResolvedValue(null);

    await expect(service.forkForTest(workspaceId, sourceConversationId)).rejects.toThrow();
    expect(createConversation).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("carries the rolling summary into the fork with a re-based watermark", async () => {
    findByIdAndWorkspaceId.mockResolvedValue(
      buildConversation({ id: sourceConversationId, workspaceId, agentId: sourceAgentId }),
    );
    // Three copyable messages plus one system row (not copied).
    listByConversationId.mockResolvedValue([
      buildMessage({ role: "user", content: "q1" }),
      buildMessage({ role: "assistant", content: "a1" }),
      buildMessage({ role: "system", content: "internal" }),
      buildMessage({ role: "user", content: "q2" }),
    ]);
    createConversation.mockResolvedValue(buildConversation({ id: forkConversationId, workspaceId, agentId: sourceAgentId }));
    const coveredThrough = new Date("2026-06-01T00:00:00.000Z");
    const loadSummary = vi.fn().mockResolvedValue({
      summary: "Long conversation context.",
      coveredMessageCount: 60,
      coveredThrough,
    });
    const saveSummary = vi.fn();
    service = new ConversationForkService(
      { findByIdAndWorkspaceId, create: createConversation } as unknown as ForkConversationRepositoryPort,
      { listByConversationId, create: createMessage } as unknown as ForkMessageRepositoryPort,
      { loadActive: loadActiveRoutineState, save: saveRoutineState } as unknown as ForkRoutineStateRepositoryPort,
      { load: loadSummary, save: saveSummary },
    );

    await service.forkForTest(workspaceId, sourceConversationId);

    expect(loadSummary).toHaveBeenCalledWith({ sessionId: sourceConversationId });
    // Watermark re-based to the fork's own (copyable) message count so the
    // source's higher count never blocks the fork's future regenerations.
    expect(saveSummary).toHaveBeenCalledWith({
      sessionId: forkConversationId,
      summary: { summary: "Long conversation context.", coveredMessageCount: 3, coveredThrough },
    });
  });

  it("does not write a summary when the source has none", async () => {
    findByIdAndWorkspaceId.mockResolvedValue(
      buildConversation({ id: sourceConversationId, workspaceId, agentId: sourceAgentId }),
    );
    listByConversationId.mockResolvedValue([]);
    createConversation.mockResolvedValue(buildConversation({ id: forkConversationId, workspaceId, agentId: sourceAgentId }));
    const loadSummary = vi.fn().mockResolvedValue(null);
    const saveSummary = vi.fn();
    service = new ConversationForkService(
      { findByIdAndWorkspaceId, create: createConversation } as unknown as ForkConversationRepositoryPort,
      { listByConversationId, create: createMessage } as unknown as ForkMessageRepositoryPort,
      { loadActive: loadActiveRoutineState, save: saveRoutineState } as unknown as ForkRoutineStateRepositoryPort,
      { load: loadSummary, save: saveSummary },
    );

    await service.forkForTest(workspaceId, sourceConversationId);

    expect(saveSummary).not.toHaveBeenCalled();
  });
});
