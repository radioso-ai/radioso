import { describe, expect, it, vi } from "vitest";

import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { RetrievalTurnController } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import {
  createAuditService,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
  pinExistingConversationsToPublishedRevisions,
  publishedRevisionResolverFixture,
} from "../support/fakes.js";

const WORKSPACE_ID = "workspace-1";

const directOnlyRetrievalTurn = () =>
  new RetrievalTurnController({
    async interpret() {
      throw new Error("retrieval is not prepared in these turns");
    },
    async runInterpreted() {
      throw new Error("retrieval is not prepared in these turns");
    },
    async runWithoutRetrieval() {
      throw new Error("retrieval is not prepared in these turns");
    },
  } as never);

const harness = async () => {
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
  const conversation = await conversationRepository.create({ workspaceId: WORKSPACE_ID, sourceChannel: "email" });
  const otherConversation = await conversationRepository.create({ workspaceId: WORKSPACE_ID, sourceChannel: "email" });
  pinExistingConversationsToPublishedRevisions(conversationRepository);
  const record = (conversationId: string, role: "user" | "assistant", content: string, workspaceId = WORKSPACE_ID) =>
    messageRepository.create({ conversationId, workspaceId, role, content });
  const earlier = [
    await record(conversation.id, "user", "Do you ship abroad?"),
    await record(conversation.id, "assistant", "We ship to most countries."),
    await record(conversation.id, "user", "How long does it take?"),
    await record(conversation.id, "assistant", "About a week."),
  ];
  const requestMessage = await record(conversation.id, "user", "Can I change my delivery address?");
  const preparer = new ChatSessionPreparer(
    conversationRepository,
    messageRepository,
    directOnlyRetrievalTurn(),
    createAuditService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    publishedRevisionResolverFixture(),
  );
  return { preparer, messageRepository, conversation, otherConversation, earlier, requestMessage, record };
};

describe("ChatSessionPreparer existing user message", () => {
  it("prepares the turn on the recorded customer message, records none, and bounds the history before it", async () => {
    const { preparer, messageRepository, conversation, earlier, requestMessage } = await harness();
    const countBefore = await messageRepository.countByConversationId(WORKSPACE_ID, conversation.id);

    const message = await preparer.loadExistingUserMessage({
      workspaceId: WORKSPACE_ID,
      conversationId: conversation.id,
      messageId: requestMessage.id,
    });
    const session = await preparer.prepare(
      { workspaceId: WORKSPACE_ID, conversationId: conversation.id, query: message.content, executionMode: "review" },
      { skipRetrieval: true, existingUserMessage: { message, historyWindow: { maxMessages: 3 } } },
    );

    expect(message).toEqual(requestMessage);
    expect(session.userMessage).toEqual(requestMessage);
    expect(session.effectiveQuery).toBe("Can I change my delivery address?");
    expect(session.conversation.id).toBe(conversation.id);
    expect(await messageRepository.countByConversationId(WORKSPACE_ID, conversation.id)).toBe(countBefore);
    expect(session.history.map((entry) => entry.id)).toEqual(earlier.slice(-3).map((entry) => entry.id));
    expect(session.skillEffects).toBe("suppressed");
  });

  it("reads no earlier message when the window is empty", async () => {
    const { preparer, conversation, requestMessage } = await harness();

    const session = await preparer.prepare(
      { workspaceId: WORKSPACE_ID, conversationId: conversation.id, query: requestMessage.content, executionMode: "review" },
      { skipRetrieval: true, existingUserMessage: { message: requestMessage, historyWindow: { maxMessages: 0 } } },
    );

    expect(session.history).toEqual([]);
  });

  it("leaves messages recorded after the answered one out of its history", async () => {
    const { preparer, conversation, earlier, requestMessage, record } = await harness();
    await record(conversation.id, "user", "Also, can I pay by invoice?");

    const session = await preparer.prepare(
      { workspaceId: WORKSPACE_ID, conversationId: conversation.id, query: requestMessage.content, executionMode: "review" },
      { skipRetrieval: true, existingUserMessage: { message: requestMessage, historyWindow: { maxMessages: 10 } } },
    );

    expect(session.history.map((entry) => entry.id)).toEqual(earlier.map((entry) => entry.id));
  });

  it("keeps the whole window before the answered message when later messages outnumber it", async () => {
    const { preparer, messageRepository, conversation, earlier, requestMessage, record } = await harness();
    for (const content of ["Also, can I pay by invoice?", "Or by card?", "Never mind, thanks."]) {
      await record(conversation.id, "user", content);
    }
    const listedBefore = vi.spyOn(messageRepository, "listBeforeByConversationId");

    const session = await preparer.prepare(
      { workspaceId: WORKSPACE_ID, conversationId: conversation.id, query: requestMessage.content, executionMode: "review" },
      { skipRetrieval: true, existingUserMessage: { message: requestMessage, historyWindow: { maxMessages: 3 } } },
    );

    expect(session.history.map((entry) => entry.id)).toEqual(earlier.slice(-3).map((entry) => entry.id));
    // The boundary is the repository's to apply, before it orders and limits.
    expect(listedBefore).toHaveBeenCalledWith(WORKSPACE_ID, conversation.id, {
      before: { createdAt: requestMessage.createdAt, id: requestMessage.id },
      limit: 3,
    });
  });

  it("rejects a message from another conversation in the same workspace", async () => {
    const { preparer, otherConversation, requestMessage } = await harness();

    await expect(preparer.loadExistingUserMessage({
      workspaceId: WORKSPACE_ID,
      conversationId: otherConversation.id,
      messageId: requestMessage.id,
    })).rejects.toMatchObject({ statusCode: 404, code: "not_found" });
  });

  it("rejects a message from another workspace", async () => {
    const { preparer, conversation, record } = await harness();
    const foreign = await record(conversation.id, "user", "Hello from elsewhere", "workspace-2");

    await expect(preparer.loadExistingUserMessage({
      workspaceId: WORKSPACE_ID,
      conversationId: conversation.id,
      messageId: foreign.id,
    })).rejects.toMatchObject({ statusCode: 404, code: "not_found" });
  });

  it("rejects a message that is not the customer's", async () => {
    const { preparer, conversation, earlier } = await harness();

    await expect(preparer.loadExistingUserMessage({
      workspaceId: WORKSPACE_ID,
      conversationId: conversation.id,
      messageId: earlier[1].id,
    })).rejects.toMatchObject({ statusCode: 404, code: "not_found" });
  });

  it("refuses to prepare another conversation's turn on the message", async () => {
    const { preparer, otherConversation, requestMessage } = await harness();

    await expect(preparer.prepare(
      { workspaceId: WORKSPACE_ID, conversationId: otherConversation.id, query: requestMessage.content, executionMode: "review" },
      { skipRetrieval: true, existingUserMessage: { message: requestMessage, historyWindow: { maxMessages: 3 } } },
    )).rejects.toMatchObject({ statusCode: 404, code: "not_found" });
  });
});
