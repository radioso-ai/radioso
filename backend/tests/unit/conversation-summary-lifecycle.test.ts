import { describe, expect, it, vi } from "vitest";

import type { AuditService } from "../../src/modules/audit/contracts/index.js";
import type { ConversationRepositoryPort } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRepositoryPort } from "../../src/db/repositories/messageRepository.js";
import {
  ChatTurnLifecycle,
  type AssistantTurnPersistencePort,
} from "../../src/modules/chat/services/chatTurnLifecycle.js";
import {
  CONVERSATION_SUMMARY_REFRESH_JOB,
  conversationSummaryRefreshHandler,
} from "../../src/modules/chat/services/summary/conversationSummaryRefreshJob.js";
import type { BackgroundJobQueue, BackgroundJobRequest } from "../../src/shared/background-jobs/index.js";
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

const turnInput = (overrides: { executionMode?: "live" | "safe_test" } = {}) => ({
  workspaceId: "ws_1",
  accountId: "acct_1",
  session: session(),
  presentation: presentation(),
  requestReceivedAt: Date.now(),
  answerStartedAt: Date.now(),
  stream: false,
  ...overrides,
});

const expectedRefresh: BackgroundJobRequest = {
  kind: "conversation.summary_refresh",
  payload: { workspaceId: "ws_1", conversationId: "conv_1", accountId: "acct_1" },
  idempotencyKey: "conv_1",
};

const lifecycleWith = (input: {
  backgroundJobs?: Pick<BackgroundJobQueue, "enqueue">;
  persistence?: AssistantTurnPersistencePort;
  logger?: Pick<AppLogger, "warn">;
}) => {
  const auditService = {
    record: vi.fn(async () => {}),
    logRecorded: vi.fn(),
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
    input.persistence,
    undefined,
    undefined,
    input.logger,
    undefined,
    undefined,
    input.backgroundJobs,
  );
};

const recordingPersistence = () => {
  const completeAssistantTurn = vi.fn<AssistantTurnPersistencePort["completeAssistantTurn"]>(async (input) => ({
    message: { id: "assistant_msg_1", conversationId: input.conversationId, workspaceId: input.workspaceId, role: "assistant", content: "Answer.", createdAt: new Date() },
    committedFacts: { insertedActionTypes: [], decisionCreated: false, ownershipChanged: false },
  }));
  return { completeAssistantTurn };
};

describe("ChatTurnLifecycle conversation summary refresh (#866)", () => {
  it("writes one refresh job, keyed by conversation, in the same commit as the reply", async () => {
    const persistence = recordingPersistence();
    const enqueue = vi.fn();
    const lifecycle = lifecycleWith({ persistence, backgroundJobs: { enqueue } });

    await lifecycle.completeAssistantTurn(turnInput());

    expect(persistence.completeAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({ backgroundJobs: [expectedRefresh] }),
    );
    // The transactional path writes the job itself; nothing is enqueued beside the commit.
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("asks for no refresh on a safe-test turn", async () => {
    const persistence = recordingPersistence();
    const lifecycle = lifecycleWith({ persistence, backgroundJobs: { enqueue: vi.fn() } });

    await lifecycle.completeAssistantTurn(turnInput({ executionMode: "safe_test" }));

    expect(persistence.completeAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({ backgroundJobs: [] }));
  });

  it("enqueues the refresh once the reply is saved where no transactional persistence is wired", async () => {
    const enqueue = vi.fn(async () => ({ inserted: true as const, jobId: "job_1" }));
    const lifecycle = lifecycleWith({ backgroundJobs: { enqueue } });

    const completed = await lifecycle.completeAssistantTurn(turnInput());

    expect(completed.assistantMessageId).toBe("assistant_msg_1");
    expect(enqueue).toHaveBeenCalledWith(expectedRefresh);
  });

  it("keeps the turn when the refresh cannot be enqueued, and logs it without content", async () => {
    const warn = vi.fn();
    const enqueue = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const lifecycle = lifecycleWith({ backgroundJobs: { enqueue }, logger: { warn } });

    await expect(lifecycle.completeAssistantTurn(turnInput())).resolves.toMatchObject({ assistantMessageId: "assistant_msg_1" });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "background_job_enqueue_failed", conversationId: "conv_1", kind: "conversation.summary_refresh" }),
      expect.any(String),
    );
  });
});

describe("conversation summary refresh job", () => {
  it("runs the summary updater for the conversation it names", async () => {
    const refresh = vi.fn(async () => {});

    await conversationSummaryRefreshHandler({ refresh }).run(
      { workspaceId: "ws_1", conversationId: "conv_1", accountId: "acct_1" },
      { jobId: "job_1", attempt: 1 },
    );

    expect(refresh).toHaveBeenCalledWith({ workspaceId: "ws_1", conversationId: "conv_1", accountId: "acct_1" });
  });

  it("gives a turn with no account an anonymous refresh", async () => {
    const refresh = vi.fn(async () => {});

    await conversationSummaryRefreshHandler({ refresh }).run(
      { workspaceId: "ws_1", conversationId: "conv_1" },
      { jobId: "job_1", attempt: 1 },
    );

    expect(refresh).toHaveBeenCalledWith({ workspaceId: "ws_1", conversationId: "conv_1" });
    expect(CONVERSATION_SUMMARY_REFRESH_JOB.kind).toBe("conversation.summary_refresh");
  });
});
