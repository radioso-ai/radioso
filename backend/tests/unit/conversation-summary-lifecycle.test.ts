import { describe, expect, it, vi } from "vitest";

import type { AuditService } from "../../src/modules/audit/contracts/index.js";
import type { ConversationRepositoryPort } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRepositoryPort } from "../../src/db/repositories/messageRepository.js";
import { ChatTurnLifecycle } from "../../src/modules/chat/services/chatTurnLifecycle.js";
import type { ConversationSummaryUpdater } from "../../src/modules/chat/services/summary/conversationSummaryService.js";
import type { AppLogger } from "../../src/shared/observability/logger.js";
import type { ChatPresentedAnswer } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { resolveContextForTurn } from "../../src/modules/context-variables/public.js";

const session = (): PreparedSession =>
  ({
    agent: { id: "agent_1", name: "Support", chatModelOverride: null },
    conversation: { id: "conv_1" },
    history: [],
    userMessage: { id: "msg_1" },
    turnRoute: "direct",
    directiveSteering: { rules: [], matches: [], omissions: [] },
    stagedContext: [],
    resolvedContext: resolveContextForTurn(null),
    retrieval: {
      contexts: [],
      diagnostics: {},
      systemPrompt: undefined,
      trace: { traceId: "trace_1", startedAt: "2026-01-01T00:00:00.000Z", stages: [], links: [] },
    },
  } as unknown as PreparedSession);

const presentation = (): ChatPresentedAnswer => ({
  answer: "Answer.",
  skillName: "assistant.chat",
  skillOutcome: "conversational",
  skillStatus: "completed",
  answerOutcome: "non_retrieval_response",
  citations: [],
});

const lifecycleWith = (updater: ConversationSummaryUpdater, logger?: Pick<AppLogger, "warn">) => {
  const auditService = {
    record: vi.fn(async () => {}),
    updateChatAnswerSuggestions: vi.fn(async () => {}),
  } as unknown as AuditService;
  const conversationRepository = { touch: vi.fn(async () => {}) } as unknown as ConversationRepositoryPort;
  const messageRepository = { create: vi.fn(async () => ({ id: "assistant_msg_1" })) } as unknown as MessageRepositoryPort;
  return new ChatTurnLifecycle(
    conversationRepository,
    messageRepository,
    auditService,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    logger,
    undefined,
    undefined,
    updater,
  );
};

describe("ChatTurnLifecycle rolling conversation summary trigger (#866)", () => {
  it("triggers regeneration but does not await it (a hanging updater never blocks the turn)", async () => {
    const refresh = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const lifecycle = lifecycleWith({ refresh });

    const completed = await lifecycle.completeAssistantTurn({
      workspaceId: "ws_1",
      accountId: "acct_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
    });

    expect(completed.assistantMessageId).toBe("assistant_msg_1");
    expect(refresh).toHaveBeenCalledWith({ workspaceId: "ws_1", conversationId: "conv_1", accountId: "acct_1" });
  });

  it("does not fail the turn when the updater rejects", async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Pick<AppLogger, "warn">;
    const refresh = vi.fn(async () => {
      throw new Error("updater blew up");
    });
    const lifecycle = lifecycleWith({ refresh }, logger);

    await expect(
      lifecycle.completeAssistantTurn({
        workspaceId: "ws_1",
        session: session(),
        presentation: presentation(),
        answerStartedAt: Date.now(),
        stream: false,
      }),
    ).resolves.toBeDefined();

    // Let the unawaited rejection settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "conversation_summary_generation_failed", conversationId: "conv_1" }),
      expect.any(String),
    );
  });
});
