import { describe, expect, it, vi } from "vitest";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";

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
  conversationSummaryRefreshRequest,
} from "../../src/modules/chat/services/summary/conversationSummaryRefreshJob.js";
import {
  BackgroundJobRuntime,
  type BackgroundJobQueue,
  type BackgroundJobRequest,
} from "../../src/shared/background-jobs/index.js";
import {
  ConversationSummaryService,
  type ConversationSummaryGenerator,
} from "../../src/modules/chat/services/summary/conversationSummaryService.js";
import type { ConversationSummaryRecord } from "../../src/modules/chat/contracts/conversationSummary.js";
import { InMemoryBackgroundJobStore } from "../support/inMemoryBackgroundJobStore.js";
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
  onDuplicateKey: "rerun",
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

const recordingPersistence = (wakeBackgroundJobs?: () => void) => {
  const completeAssistantTurn = vi.fn<AssistantTurnPersistencePort["completeAssistantTurn"]>(async (input) => ({
    message: { id: "assistant_msg_1", conversationId: input.conversationId, workspaceId: input.workspaceId, role: "assistant", content: "Answer.", createdAt: new Date() },
    committedFacts: { insertedActionTypes: [], decisionCreated: false, ownershipChanged: false },
    ...(wakeBackgroundJobs ? { wakeBackgroundJobs } : {}),
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

  it("wakes the worker for the jobs it wrote once its own transaction has committed", async () => {
    const wake = vi.fn();
    const lifecycle = lifecycleWith({ persistence: recordingPersistence(wake), backgroundJobs: { enqueue: vi.fn() } });

    const completed = await lifecycle.completeAssistantTurn(turnInput());

    expect(wake).toHaveBeenCalledOnce();
    expect(completed).not.toHaveProperty("postCommitWake");
  });

  it("hands the wake to the owner of a caller's transaction instead of firing it before that commit", async () => {
    const wake = vi.fn();
    const lifecycle = lifecycleWith({ persistence: recordingPersistence(wake), backgroundJobs: { enqueue: vi.fn() } });

    const completed = await lifecycle.completeAssistantTurn({ ...turnInput(), transaction: {} as never });

    expect(wake).not.toHaveBeenCalled();
    expect(completed).toMatchObject({ kind: "persisted", postCommitWake: wake });
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

/** The conversation every refresh job below names, as the conversation store finds it. */
const presentConversation = { findByIdAndWorkspaceId: async () => ({ id: "conv_1" }) as never };

describe("conversation summary refresh job", () => {
  it("ends skipped without a refresh when its conversation was erased before it ran", async () => {
    const refresh = vi.fn(async () => {});

    const outcome = await conversationSummaryRefreshHandler({ refresh }, { findByIdAndWorkspaceId: async () => null }).run(
      { workspaceId: "ws_1", conversationId: "conv_1" },
      { jobId: "job_1", attempt: 1, signal: new AbortController().signal },
    );

    expect(outcome).toEqual({ skipped: "conversation_not_found" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("ends skipped instead of retrying when its conversation was erased while it ran", async () => {
    let present = true;
    const refresh = vi.fn(async () => {
      present = false;
      throw new Error("insert or update on table \"conversation_summaries\" violates foreign key constraint");
    });
    const conversations = { findByIdAndWorkspaceId: async () => (present ? ({ id: "conv_1" }) as never : null) };

    const outcome = await conversationSummaryRefreshHandler({ refresh }, conversations).run(
      { workspaceId: "ws_1", conversationId: "conv_1" },
      { jobId: "job_1", attempt: 1, signal: new AbortController().signal },
    );

    expect(outcome).toEqual({ skipped: "conversation_not_found" });
  });

  it("still fails a refresh whose conversation exists, so the job retries", async () => {
    const refresh = vi.fn(async () => { throw new Error("provider exploded"); });

    await expect(conversationSummaryRefreshHandler({ refresh }, presentConversation).run(
      { workspaceId: "ws_1", conversationId: "conv_1" },
      { jobId: "job_1", attempt: 1, signal: new AbortController().signal },
    )).rejects.toThrow("provider exploded");
  });

  it("runs the summary updater for the conversation it names", async () => {
    const refresh = vi.fn(async () => {});

    const signal = new AbortController().signal;

    await conversationSummaryRefreshHandler({ refresh }, presentConversation).run(
      { workspaceId: "ws_1", conversationId: "conv_1", accountId: "acct_1" },
      { jobId: "job_1", attempt: 1, signal },
    );

    expect(refresh).toHaveBeenCalledWith({ workspaceId: "ws_1", conversationId: "conv_1", accountId: "acct_1" }, { signal });
  });

  it("gives a turn with no account an anonymous refresh", async () => {
    const refresh = vi.fn(async () => {});

    await conversationSummaryRefreshHandler({ refresh }, presentConversation).run(
      { workspaceId: "ws_1", conversationId: "conv_1" },
      { jobId: "job_1", attempt: 1, signal: new AbortController().signal },
    );

    expect(refresh).toHaveBeenCalledWith({ workspaceId: "ws_1", conversationId: "conv_1" }, expect.anything());
    expect(CONVERSATION_SUMMARY_REFRESH_JOB.kind).toBe("conversation.summary_refresh");
  });

  it("retries a refresh whose model call failed, then saves the summary on the next attempt", async () => {
    const clock = { now: () => new Date(Date.now()) };
    const store = new InMemoryBackgroundJobStore(clock);
    const saved: ConversationSummaryRecord[] = [];
    const messages: MessageRecord[] = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index}`,
      conversationId: "conv_1",
      workspaceId: "ws_1",
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      createdAt: new Date(Date.UTC(2026, 9, 15, 10, index)),
    }));
    const generate = vi.fn<ConversationSummaryGenerator["generate"]>()
      .mockRejectedValueOnce(new Error("provider exploded"))
      .mockResolvedValue({ summary: "They asked about shipping." });
    const updater = new ConversationSummaryService(
      { load: async () => null, save: async ({ summary }) => { saved.push(summary); } },
      {
        countByConversationId: async () => messages.length,
        listRecentByConversationId: async (_workspaceId, _conversationId, limit) => messages.slice(-limit),
      },
      { generate },
      { getTitle: async () => null, setTitle: async () => {} },
      { generate: async () => ({}) },
    );
    const runtime = new BackgroundJobRuntime({
      store,
      handlers: [conversationSummaryRefreshHandler(updater, presentConversation)],
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: clock.now,
    });
    await store.insert(conversationSummaryRefreshRequest({ workspaceId: "ws_1", conversationId: "conv_1" }));

    expect(await runtime.drain({ maxJobs: 1 })).toMatchObject({ retried: 1 });
    expect([...store.rows.values()][0]).toMatchObject({ status: "pending", attempts: 1, lastError: "Error" });
    expect(saved).toEqual([]);

    vi.useFakeTimers({ now: Date.now() + 31_000 });
    try {
      expect(await runtime.drain({ maxJobs: 1 })).toMatchObject({ completed: 1 });
    } finally {
      vi.useRealTimers();
    }
    expect(saved).toEqual([expect.objectContaining({ summary: "They asked about shipping.", coveredMessageCount: 12 })]);
    expect(store.rows.size).toBe(0);
  });
});
