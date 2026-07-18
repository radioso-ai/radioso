import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import { ChatTurnSupersededError } from "../../src/modules/chat/services/conversationTurnRegistry.js";
import type { TurnRouter } from "../../src/modules/chat/services/turnRouter.js";
import { createTestDependencies } from "../support/testApp.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
    expect(firstEvents).toEqual([
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

    const firstEventsPromise = collect(ctx.dependencies.assistantChatService.streamAnswer({
      workspaceId,
      agentId: agent.id,
      conversationId: conversation.id,
      message: "first question",
      stream: true,
    }));
    await firstChunkYielded.promise;

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
});
