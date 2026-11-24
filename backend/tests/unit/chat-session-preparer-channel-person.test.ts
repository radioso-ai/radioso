import { describe, expect, it, vi } from "vitest";

import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { RetrievalTurnController } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { ChannelPersonKey, ConversationChannelPersonKeys } from "../../src/shared/domain/channelPersonKey.js";
import {
  createAuditService,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
  pinExistingConversationsToPublishedRevisions,
  publishedRevisionResolverFixture,
} from "../support/fakes.js";

const WORKSPACE_ID = "workspace-1";
// Obviously fake numbers in the reserved 555-01xx range.
const RECORDED: ChannelPersonKey = { kind: "whatsapp_contact", id: "15550100101" };
const ATTESTED: ChannelPersonKey = { kind: "whatsapp_contact", id: "15550100102" };

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

/** A preparer whose conversations' channel keeps `RECORDED` as the person of each WhatsApp conversation. */
const harness = async () => {
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
  const whatsApp = await conversationRepository.create({ workspaceId: WORKSPACE_ID, sourceChannel: "whatsapp" });
  pinExistingConversationsToPublishedRevisions(conversationRepository);
  const personKeys = {
    personKeyOf: vi.fn<ConversationChannelPersonKeys["personKeyOf"]>(async ({ sourceChannel }) => (sourceChannel === "whatsapp" ? RECORDED : null)),
  };
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
    undefined,
    undefined,
    undefined,
    undefined,
    personKeys,
  );
  const request = await messageRepository.create({ conversationId: whatsApp.id, workspaceId: WORKSPACE_ID, role: "user", content: "Is my table still booked?" });
  return { preparer, personKeys, whatsApp, request };
};

describe("ChatSessionPreparer and the person a channel keeps", () => {
  it("runs a turn that carries no person key, such as a review of a recorded message, as the person its conversation's channel keeps", async () => {
    const { preparer, personKeys, whatsApp, request } = await harness();

    const session = await preparer.prepare(
      { workspaceId: WORKSPACE_ID, conversationId: whatsApp.id, query: request.content, executionMode: "review" },
      { skipRetrieval: true, existingUserMessage: { message: request, historyWindow: { maxMessages: 3 } } },
    );

    expect(session.channelPersonKey).toEqual(RECORDED);
    expect(personKeys.personKeyOf).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, conversationId: whatsApp.id, sourceChannel: "whatsapp" });
  });

  it("keeps the person key a turn carries, and looks up none for a conversation the turn starts", async () => {
    const { preparer, personKeys, whatsApp } = await harness();

    const carried = await preparer.prepare(
      { workspaceId: WORKSPACE_ID, conversationId: whatsApp.id, query: "And for six?", channelPersonKey: ATTESTED },
      { skipRetrieval: true },
    );
    const started = await preparer.prepare({ workspaceId: WORKSPACE_ID, query: "Hello", sourceChannel: "website_embed" }, { skipRetrieval: true });

    expect(carried.channelPersonKey).toEqual(ATTESTED);
    expect(started.channelPersonKey).toBeNull();
    expect(personKeys.personKeyOf).not.toHaveBeenCalled();
  });
});
