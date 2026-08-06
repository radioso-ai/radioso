import { describe, expect, it, vi } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import type { ChatStreamEvent } from "../../src/modules/chat/contracts/streamEvents.js";
import { ChatTurnSupersededError } from "../../src/modules/chat/services/conversationTurnRegistry.js";
import type { TurnRouter } from "../../src/modules/chat/services/turnRouter.js";
import type {
  UsageLimitPolicy,
  UsageLimitReservation,
} from "../../src/shared/domain/usageLimitPolicy.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { createTestDependencies } from "../support/testApp.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const rejectableDeferred = () => {
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
};

const directRouting = (): Awaited<ReturnType<TurnRouter["classify"]>> => ({
  route: "direct",
  framing: { isIdentityQuestion: false },
});

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
};

// Status events are informational and race supersession: the #859 contract permits
// statuses before `cancelled` without guaranteeing them. Cancellation tests assert the
// deterministic non-status sequence and separately that `cancelled` is the last event.
const withoutStatusEvents = <T extends { type: string }>(events: T[]): T[] =>
  events.filter((event) => event.type !== "status");

const noopReservation = (): UsageLimitReservation => ({
  async commit() {},
  async release() {},
});

const usagePolicyWith = (
  reserveAnswer: UsageLimitPolicy["reserveAnswer"],
): UsageLimitPolicy => ({
  reserveAnswer,
  async reserveDocument() {
    return noopReservation();
  },
  async reserveIndexedStorage() {
    return noopReservation();
  },
  async reserveMonthlyIndexedContent() {
    return noopReservation();
  },
});

const createChatContext = async (overrides: Parameters<typeof createTestDependencies>[0]) => {
  const ctx = createTestDependencies(overrides);
  const workspace = await ctx.dependencies.workspaceRepository.create(
    "account-1",
    "Interruption test workspace",
  );
  const agent = await ctx.dependencies.agentService.resolve(workspace.id);
  return { ...ctx, agent, workspaceId: workspace.id };
};

describe("chat interruption", () => {
  it("cancels a turn during preparation and persists one answer for the latest message", async () => {
    const firstPreparationStarted = deferred();
    const releaseFirstPreparation = deferred();
    const turnRouter: TurnRouter = {
      async classify(input) {
        if (input.query === "first question") {
          firstPreparationStarted.resolve();
          await releaseFirstPreparation.promise;
        }
        return directRouting();
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
    const ctx = await createChatContext({ chatGateway, turnRouter });
    const { agent, workspaceId } = ctx;
    const conversation = await ctx.repositories.conversationRepository.create(
      workspaceId,
      agent.id,
      "authenticated_chat",
    );

    const first = ctx.dependencies.assistantChatService.answer({
      workspaceId,
      agentId: agent.id,
      conversationId: conversation.id,
      message: "first question",
      stream: false,
    });
    await firstPreparationStarted.promise;

    const latest = ctx.dependencies.assistantChatService.answer({
      workspaceId,
      agentId: agent.id,
      conversationId: conversation.id,
      message: "latest question",
      stream: false,
    });
    releaseFirstPreparation.resolve();

    await expect(first).rejects.toBeInstanceOf(ChatTurnSupersededError);
    await expect(latest).resolves.toMatchObject({
      answer: "latest=latest question; history=first question",
    });

    const messages = await ctx.repositories.messageRepository.listByConversationId(workspaceId, conversation.id);
    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "first question" },
      { role: "user", content: "latest question" },
      { role: "assistant", content: "latest=latest question; history=first question" },
    ]);
  });

  it("records a superseded turn as an accountable, non-error event visible only to the dashboard surface", async () => {
    const firstPreparationStarted = deferred();
    const releaseFirstPreparation = deferred();
    const turnRouter: TurnRouter = {
      async classify(input) {
        if (input.query === "first question") {
          firstPreparationStarted.resolve();
          await releaseFirstPreparation.promise;
        }
        return directRouting();
      },
    };
    const chatGateway: ChatGateway = {
      async answer(input) {
        return `latest=${input.query}`;
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const ctx = await createChatContext({ chatGateway, turnRouter });
    const { agent, workspaceId } = ctx;
    const conversation = await ctx.repositories.conversationRepository.create(
      workspaceId,
      agent.id,
      "authenticated_chat",
    );

    const first = ctx.dependencies.assistantChatService.answer({
      workspaceId,
      agentId: agent.id,
      conversationId: conversation.id,
      message: "first question",
      stream: false,
    });
    await firstPreparationStarted.promise;
    const latest = ctx.dependencies.assistantChatService.answer({
      workspaceId,
      agentId: agent.id,
      conversationId: conversation.id,
      message: "latest question",
      stream: false,
    });
    releaseFirstPreparation.resolve();

    await expect(first).rejects.toBeInstanceOf(ChatTurnSupersededError);
    await expect(latest).resolves.toMatchObject({ answer: "latest=latest question" });

    const messages = await ctx.repositories.messageRepository.listByConversationId(workspaceId, conversation.id);
    const firstUserMessage = messages.find((message) => message.content === "first question");
    expect(firstUserMessage).toBeDefined();

    // The superseded turn's only trace is this audit event: no assistant message was
    // ever created for it. It must be recorded, and never as a "failure" — the visitor
    // just kept typing.
    const chatAnswerEvents = ctx.repositories.auditEventRepository.items.filter(
      (event) => event.eventType === "chat.answer" && event.metadata.userMessageId === firstUserMessage!.id,
    );
    expect(chatAnswerEvents).toHaveLength(1);
    expect(chatAnswerEvents[0].eventStatus).toBe("cancelled");
    expect(chatAnswerEvents[0].eventStatus).not.toBe("failure");
    expect(chatAnswerEvents[0].metadata).not.toHaveProperty("errorMessage");

    // Dashboard surface: the interrupted user message carries the turn-failure debug.
    const dashboardDetail = await ctx.dependencies.assistantHistoryService.getConversation(
      workspaceId,
      conversation.id,
      { limit: 50 },
    );
    const dashboardFirstMessage = dashboardDetail.messages.find((message) => message.content === "first question");
    expect(dashboardFirstMessage?.turnFailure).toMatchObject({
      eventStatus: "cancelled",
      stage: "routing",
    });

    // Public/embed surface: the SAME conversation read through the method the public
    // route calls directly (no dashboard options) must never see it.
    const publicDetail = await ctx.dependencies.chatHistoryService.getConversation(
      workspaceId,
      conversation.id,
      { limit: 50 },
    );
    const publicFirstMessage = publicDetail.messages.find((message) => message.content === "first question");
    expect(publicFirstMessage?.turnFailure).toBeUndefined();
  });

  it("terminates a superseded pre-emission stream without a chunk or done event", async () => {
    const firstPreparationStarted = deferred();
    const releaseFirstPreparation = deferred();
    const turnRouter: TurnRouter = {
      async classify(input) {
        if (input.query === "first streamed question") {
          firstPreparationStarted.resolve();
          await releaseFirstPreparation.promise;
        }
        return directRouting();
      },
    };
    const chatGateway: ChatGateway = {
      async answer(input) {
        return `answer for ${input.query}`;
      },
      async *streamAnswer(input) {
        yield `stream answer for ${input.query}`;
      },
    };
    const ctx = await createChatContext({ chatGateway, turnRouter });
    const { agent, workspaceId } = ctx;
    const conversation = await ctx.repositories.conversationRepository.create(
      workspaceId,
      agent.id,
      "authenticated_chat",
    );

    const firstEventsPromise = collect(ctx.dependencies.assistantChatService.streamAnswer({
      workspaceId,
      agentId: agent.id,
      conversationId: conversation.id,
      message: "first streamed question",
      stream: true,
    }));
    await firstPreparationStarted.promise;
    const latest = ctx.dependencies.assistantChatService.answer({
      workspaceId,
      agentId: agent.id,
      conversationId: conversation.id,
      message: "latest question",
      stream: false,
    });
    releaseFirstPreparation.resolve();

    const firstEvents = await firstEventsPromise;
    await expect(latest).resolves.toMatchObject({ answer: "answer for latest question" });
    expect(firstEvents.at(-1)).toMatchObject({ type: "cancelled" });
    expect(withoutStatusEvents(firstEvents)).toEqual([
      { type: "conversation", conversationId: conversation.id },
      {
        type: "cancelled",
        conversationId: conversation.id,
        reason: "superseded",
        stage: "routing",
      },
    ]);

    const messages = await ctx.repositories.messageRepository.listByConversationId(workspaceId, conversation.id);
    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "first streamed question" },
      { role: "user", content: "latest question" },
      { role: "assistant", content: "answer for latest question" },
    ]);
  });

  it("lets an emitting turn complete before processing and persisting its successor", async () => {
    const firstChunkYielded = deferred();
    const releaseFirstStream = deferred();
    const chatGateway: ChatGateway = {
      async answer(input) {
        return `answer for ${input.query}`;
      },
      async *streamAnswer(input) {
        if (input.query === "first question") {
          yield "complete first answer";
          firstChunkYielded.resolve();
          await releaseFirstStream.promise;
          return;
        }
        yield `stream answer for ${input.query}`;
      },
    };
    const ctx = await createChatContext({
      chatGateway,
      turnRouter: { classify: async () => directRouting() },
    });
    const { agent, workspaceId } = ctx;
    const conversation = await ctx.repositories.conversationRepository.create(
      workspaceId,
      agent.id,
      "authenticated_chat",
    );

    // The emission latch engages on the first PUBLIC chunk, not on the provider yield:
    // a produced-but-not-yet-emitted chunk is still discardable by a successor (#859
    // status/queue design). Synchronize on the public chunk so this test exercises the
    // post-latch guarantee it is named for.
    const firstPublicChunk = deferred();
    const firstEventsPromise = (async () => {
      const events: ChatStreamEvent[] = [];
      for await (const event of ctx.dependencies.assistantChatService.streamAnswer({
        workspaceId,
        agentId: agent.id,
        conversationId: conversation.id,
        message: "first question",
        stream: true,
      })) {
        events.push(event);
        if (event.type === "chunk") {
          firstPublicChunk.resolve();
        }
      }
      return events;
    })();
    await firstChunkYielded.promise;
    await firstPublicChunk.promise;

    let secondSettled = false;
    const second = ctx.dependencies.assistantChatService.answer({
      workspaceId,
      agentId: agent.id,
      conversationId: conversation.id,
      message: "second question",
      stream: false,
    }).finally(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseFirstStream.resolve();
    const firstEvents = await firstEventsPromise;
    await expect(second).resolves.toMatchObject({ answer: "answer for second question" });

    expect(firstEvents).toEqual(expect.arrayContaining([
      { type: "chunk", text: "complete first answer" },
      expect.objectContaining({ type: "done", answer: "complete first answer" }),
    ]));
    const messages = await ctx.repositories.messageRepository.listByConversationId(workspaceId, conversation.id);
    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "complete first answer" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "answer for second question" },
    ]);
  });

  it("stops after retrieval work when the turn is cancelled before dispatch", async () => {
    const retrievalStarted = deferred();
    const releaseRetrieval = deferred();
    let retrievalCalls = 0;
    const answer = vi.fn(async (input: { query: string }) => `answer for ${input.query}`);
    const ctx = await createChatContext({
      lexicalSearch: {
        async search() {
          retrievalCalls += 1;
          if (retrievalCalls === 1) {
            retrievalStarted.resolve();
            await releaseRetrieval.promise;
          }
          return [];
        },
      },
      turnRouter: {
        classify: async (input) => input.query === "first question"
          ? { route: "retrieval", framing: { isIdentityQuestion: false } }
          : directRouting(),
      },
      chatGateway: {
        answer,
        async *streamAnswer() {
          yield "unused";
        },
      },
    });
    const conversation = await ctx.repositories.conversationRepository.create(
      ctx.workspaceId,
      ctx.agent.id,
      "authenticated_chat",
    );

    const first = ctx.dependencies.assistantChatService.answer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "first question",
      stream: false,
    });
    await retrievalStarted.promise;
    const latest = ctx.dependencies.assistantChatService.answer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "latest question",
      stream: false,
    });
    releaseRetrieval.resolve();

    await expect(first).rejects.toBeInstanceOf(ChatTurnSupersededError);
    await expect(latest).resolves.toMatchObject({ answer: "answer for latest question" });
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ query: "latest question" }));
  });

  it("prefers non-streaming supersession when the blocked stage later rejects", async () => {
    const stageStarted = deferred();
    const stageFailure = rejectableDeferred();
    const ctx = await createChatContext({
      turnRouter: {
        async classify(input) {
          if (input.query === "first question") {
            stageStarted.resolve();
            await stageFailure.promise;
          }
          return directRouting();
        },
      },
    });
    const recordFailure = vi.spyOn(
      (ctx.dependencies.chatService as unknown as { chatTurnLifecycle: { recordFailure: (...args: unknown[]) => Promise<void> } }).chatTurnLifecycle,
      "recordFailure",
    );
    const conversation = await ctx.repositories.conversationRepository.create(
      ctx.workspaceId,
      ctx.agent.id,
      "authenticated_chat",
    );

    const first = ctx.dependencies.assistantChatService.answer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "first question",
      stream: false,
    });
    await stageStarted.promise;
    const latest = ctx.dependencies.assistantChatService.answer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "latest question",
      stream: false,
    });
    stageFailure.reject(new Error("provider failed after cancellation"));

    await expect(first).rejects.toBeInstanceOf(ChatTurnSupersededError);
    await expect(latest).resolves.toMatchObject({ answer: expect.any(String) });
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("prefers streaming supersession when the blocked stage later rejects", async () => {
    const stageStarted = deferred();
    const stageFailure = rejectableDeferred();
    const ctx = await createChatContext({
      turnRouter: {
        async classify(input) {
          if (input.query === "first question") {
            stageStarted.resolve();
            await stageFailure.promise;
          }
          return directRouting();
        },
      },
    });
    const recordFailure = vi.spyOn(
      (ctx.dependencies.chatService as unknown as { chatTurnLifecycle: { recordFailure: (...args: unknown[]) => Promise<void> } }).chatTurnLifecycle,
      "recordFailure",
    );
    const conversation = await ctx.repositories.conversationRepository.create(
      ctx.workspaceId,
      ctx.agent.id,
      "authenticated_chat",
    );

    const firstEvents = collect(ctx.dependencies.assistantChatService.streamAnswer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "first question",
      stream: true,
    }));
    await stageStarted.promise;
    const latest = ctx.dependencies.assistantChatService.answer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "latest question",
      stream: false,
    });
    stageFailure.reject(new Error("provider failed after cancellation"));

    const settledFirstEvents = await firstEvents;
    expect(settledFirstEvents.at(-1)).toMatchObject({ type: "cancelled" });
    expect(withoutStatusEvents(settledFirstEvents)).toEqual([
      { type: "conversation", conversationId: conversation.id },
      {
        type: "cancelled",
        conversationId: conversation.id,
        reason: "superseded",
        stage: "routing",
      },
    ]);
    await expect(latest).resolves.toMatchObject({ answer: expect.any(String) });
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("prefers non-streaming supersession when usage reservation acquisition rejects after cancellation", async () => {
    const acquisitionStarted = deferred();
    const acquisitionFailure = rejectableDeferred();
    let reservations = 0;
    const ctx = await createChatContext({
      usageLimitPolicy: usagePolicyWith(async () => {
        reservations += 1;
        if (reservations === 1) {
          acquisitionStarted.resolve();
          await acquisitionFailure.promise;
        }
        return noopReservation();
      }),
    });
    const conversation = await ctx.repositories.conversationRepository.create(
      ctx.workspaceId,
      ctx.agent.id,
      "authenticated_chat",
    );

    const first = ctx.dependencies.assistantChatService.answer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "first question",
      stream: false,
    });
    await acquisitionStarted.promise;
    const latest = ctx.dependencies.assistantChatService.answer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "latest question",
      stream: false,
    });
    acquisitionFailure.reject(new Error("reservation unavailable after cancellation"));

    await expect(first).rejects.toBeInstanceOf(ChatTurnSupersededError);
    await expect(latest).resolves.toMatchObject({ answer: expect.any(String) });
    expect(reservations).toBe(2);
  });

  it("prefers streaming supersession when usage reservation acquisition rejects after cancellation", async () => {
    const acquisitionStarted = deferred();
    const acquisitionFailure = rejectableDeferred();
    let reservations = 0;
    const ctx = await createChatContext({
      usageLimitPolicy: usagePolicyWith(async () => {
        reservations += 1;
        if (reservations === 1) {
          acquisitionStarted.resolve();
          await acquisitionFailure.promise;
        }
        return noopReservation();
      }),
    });
    const conversation = await ctx.repositories.conversationRepository.create(
      ctx.workspaceId,
      ctx.agent.id,
      "authenticated_chat",
    );

    const firstEvents = collect(ctx.dependencies.assistantChatService.streamAnswer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "first question",
      stream: true,
    }));
    await acquisitionStarted.promise;
    const latest = ctx.dependencies.assistantChatService.answer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "latest question",
      stream: false,
    });
    acquisitionFailure.reject(new Error("reservation unavailable after cancellation"));

    const settledFirstEvents = await firstEvents;
    expect(settledFirstEvents.at(-1)).toMatchObject({ type: "cancelled" });
    expect(withoutStatusEvents(settledFirstEvents)).toEqual([{
      type: "cancelled",
      conversationId: conversation.id,
      reason: "superseded",
      stage: "waiting",
    }]);
    await expect(latest).resolves.toMatchObject({ answer: expect.any(String) });
    expect(reservations).toBe(2);
  });

  it("keeps non-streaming supersession terminal when reservation release fails", async () => {
    const routingStarted = deferred();
    const releaseRouting = deferred();
    let reservations = 0;
    const release = vi.fn(async () => {
      throw new Error("release unavailable");
    });
    const logger = createLogger("silent");
    const warn = vi.fn();
    logger.warn = warn as never;
    const ctx = await createChatContext({
      logger,
      usageLimitPolicy: usagePolicyWith(async () => {
        reservations += 1;
        return reservations === 1
          ? { commit: async () => undefined, release }
          : noopReservation();
      }),
      turnRouter: {
        async classify(input) {
          if (input.query === "first question") {
            routingStarted.resolve();
            await releaseRouting.promise;
          }
          return directRouting();
        },
      },
    });
    const conversation = await ctx.repositories.conversationRepository.create(
      ctx.workspaceId,
      ctx.agent.id,
      "authenticated_chat",
    );

    const first = ctx.dependencies.assistantChatService.answer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "first question",
      stream: false,
    });
    await routingStarted.promise;
    const latest = ctx.dependencies.assistantChatService.answer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "latest question",
      stream: false,
    });
    releaseRouting.resolve();

    await expect(first).rejects.toBeInstanceOf(ChatTurnSupersededError);
    await expect(latest).resolves.toMatchObject({ answer: expect.any(String) });
    expect(release).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: ctx.workspaceId,
        conversationId: conversation.id,
        stream: false,
        errorType: "Error",
      }),
      "Chat usage reservation release failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("release unavailable");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("first question");
  });

  it("emits streaming cancellation even when reservation release fails", async () => {
    const routingStarted = deferred();
    const releaseRouting = deferred();
    let reservations = 0;
    const release = vi.fn(async () => {
      throw new Error("release unavailable");
    });
    const ctx = await createChatContext({
      usageLimitPolicy: usagePolicyWith(async () => {
        reservations += 1;
        return reservations === 1
          ? { commit: async () => undefined, release }
          : noopReservation();
      }),
      turnRouter: {
        async classify(input) {
          if (input.query === "first question") {
            routingStarted.resolve();
            await releaseRouting.promise;
          }
          return directRouting();
        },
      },
    });
    const conversation = await ctx.repositories.conversationRepository.create(
      ctx.workspaceId,
      ctx.agent.id,
      "authenticated_chat",
    );

    const firstEvents = collect(ctx.dependencies.assistantChatService.streamAnswer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "first question",
      stream: true,
    }));
    await routingStarted.promise;
    const latest = ctx.dependencies.assistantChatService.answer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "latest question",
      stream: false,
    });
    releaseRouting.resolve();

    const settledFirstEvents = await firstEvents;
    expect(settledFirstEvents.at(-1)).toMatchObject({ type: "cancelled" });
    expect(withoutStatusEvents(settledFirstEvents)).toEqual([
      { type: "conversation", conversationId: conversation.id },
      {
        type: "cancelled",
        conversationId: conversation.id,
        reason: "superseded",
        stage: "routing",
      },
    ]);
    await expect(latest).resolves.toMatchObject({ answer: expect.any(String) });
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the lease at done while lazy suggestions are still pending", async () => {
    const suggestions = deferred();
    const secondAnswerStarted = deferred();
    const chatGateway: ChatGateway = {
      async answer(input) {
        if (input.query === "second question") {
          secondAnswerStarted.resolve();
        }
        return `answer for ${input.query}`;
      },
      async *streamAnswer(input) {
        yield `answer for ${input.query}`;
      },
    };
    const ctx = await createChatContext({
      chatGateway,
      turnRouter: { classify: async () => directRouting() },
    });
    vi.spyOn(
      ctx.dependencies.chatService as unknown as {
        composeLazySuggestions: (...args: unknown[]) => Promise<unknown>;
      },
      "composeLazySuggestions",
    ).mockReturnValue(suggestions.promise);
    const conversation = await ctx.repositories.conversationRepository.create(
      ctx.workspaceId,
      ctx.agent.id,
      "authenticated_chat",
    );
    const iterator = ctx.dependencies.assistantChatService.streamAnswer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "first question",
      stream: true,
    })[Symbol.asyncIterator]();

    let next = await iterator.next();
    while (!next.done && next.value.type !== "done") {
      next = await iterator.next();
    }
    expect(next.value).toMatchObject({ type: "done", answer: "answer for first question" });

    const second = ctx.dependencies.assistantChatService.answer({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agent.id,
      conversationId: conversation.id,
      message: "second question",
      stream: false,
    });
    await expect(secondAnswerStarted.promise).resolves.toBeUndefined();

    suggestions.resolve();
    await iterator.return?.();
    await expect(second).resolves.toMatchObject({ answer: "answer for second question" });
  });
});
