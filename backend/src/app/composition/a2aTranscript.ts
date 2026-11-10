import type { AgentRepositoryPort } from "../../db/repositories/agentRepository.js";
import type { ConversationRepositoryPort } from "../../db/repositories/conversationRepository.js";
import { deriveMessageSourceFromRole, type MessageRepositoryPort } from "../../db/repositories/messageRepository.js";
import type { A2aAgentDirectory, A2aTranscriptMessage, A2aTranscriptPort } from "../../modules/a2a/public.js";
import type { AgentPublicationReader } from "../../modules/agents/public.js";
import type { ConversationTailReaderPort } from "../../modules/chat/contracts/index.js";

const toIso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : value);

/**
 * The conversation reads A2A tasks are computed from. A read after a cursor is the same tail the
 * calling-agent update reader adapts, taken with each message's stored source, because the update
 * reader labels the caller's own messages `agent`. A task's history is a range of message ids,
 * read with the message store's boundary read.
 */
export const createA2aTranscript = (dependencies: {
  history: ConversationTailReaderPort;
  messages: Pick<MessageRepositoryPort, "listBeforeByConversationId" | "findByIdAndWorkspaceId">;
  conversations: Pick<ConversationRepositoryPort, "listPageByAnonymousSession">;
}): A2aTranscriptPort => ({
  async conversationIdFor(opening) {
    const page = await dependencies.conversations.listPageByAnonymousSession(
      opening.workspaceId,
      opening.publicSessionId,
      { limit: 1, agentId: opening.agentId },
    );
    return page.conversations[0]?.id ?? null;
  },

  async readAfter(input) {
    const tail = await dependencies.history.tailConversation(
      input.workspaceId,
      input.conversationId,
      { ...(input.cursor ? { cursor: input.cursor } : {}), limit: input.limit },
      { includeOwnership: true },
    );
    return {
      messages: tail.messages.map((message) => ({
        id: message.id,
        source: message.source,
        text: message.content,
        createdAt: message.createdAt,
      })),
      cursor: tail.cursor,
      // The ownership record is written lazily: no record means the AI owns the thread.
      ownership: tail.ownership?.state === "human_owned" ? "human_owned" : "ai_owned",
    };
  },

  async readRange(input) {
    const through = await dependencies.messages.findByIdAndWorkspaceId(input.workspaceId, input.throughMessageId);
    if (!through || through.conversationId !== input.conversationId) {
      return [];
    }
    const earlier = input.fromMessageId === input.throughMessageId || input.limit <= 1
      ? []
      : await dependencies.messages.listBeforeByConversationId(input.workspaceId, input.conversationId, {
        beforeMessageId: input.throughMessageId,
        limit: input.limit - 1,
      });
    const window = [...earlier, through];
    // The range starts at its opening message; a window that does not reach it is all inside the range.
    const start = window.findIndex((message) => message.id === input.fromMessageId);
    return window.slice(Math.max(start, 0)).map((message): A2aTranscriptMessage => ({
      id: message.id,
      source: message.source ?? deriveMessageSourceFromRole(message.role),
      text: message.content,
      createdAt: toIso(message.createdAt),
    }));
  },
});

/**
 * The agent a public id serves A2A for, on the conditions its card is served on: the agent exists,
 * its card is switched on, and it has a published release. Anything else is the card's 404.
 */
export const createA2aAgentDirectory = (dependencies: {
  agentRepository: Pick<AgentRepositoryPort, "findByPublicId">;
  agentPublication: AgentPublicationReader;
}): A2aAgentDirectory => ({
  async resolve(publicId) {
    const agent = await dependencies.agentRepository.findByPublicId(publicId);
    if (!agent || agent.publicId !== publicId || !agent.agentCardEnabled) {
      return null;
    }
    const published = await dependencies.agentPublication.isPublished({ workspaceId: agent.workspaceId, agentId: agent.id });
    return published ? { agentId: agent.id, workspaceId: agent.workspaceId } : null;
  },
});
