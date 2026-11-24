import { describe, expect, it, vi } from "vitest";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import { ContextClassificationExcerptReader } from "../../src/modules/chat/services/contextClassificationExcerptReader.js";
import { sensitiveTurnMetadata } from "../../src/shared/domain/sensitiveTranscript.js";

const workspaceId = "workspace-1";
const conversationId = "conversation-1";

const message = (content: string, overrides: Partial<MessageRecord> = {}): MessageRecord => ({
  id: `message-${content}`,
  conversationId,
  workspaceId,
  role: "user",
  content,
  createdAt: new Date(0),
  ...overrides,
});

const readerWith = (input: { messages: MessageRecord[]; summary?: string | null; conversation?: boolean }) => {
  const listRecentByConversationId = vi.fn(async () => input.messages);
  const reader = new ContextClassificationExcerptReader({
    conversations: { findByIdAndWorkspaceId: vi.fn(async () => (input.conversation === false ? null : { id: conversationId } as never)) },
    messages: { listRecentByConversationId },
    summaries: { load: vi.fn(async () => (input.summary ? { summary: input.summary, coveredMessageCount: 4, coveredThrough: new Date(0) } : null)) },
  });
  return { reader, listRecentByConversationId };
};

describe("ContextClassificationExcerptReader", () => {
  it("reads the summary and the visitor's latest messages, cut to the requested length", async () => {
    const { reader, listRecentByConversationId } = readerWith({
      summary: "The visitor asks about an October invoice.",
      messages: [message("Hallo"), message("Wo ist meine Rechnung vom Oktober?")],
    });

    await expect(reader.readExcerpt({ workspaceId, conversationId, maxMessages: 6, maxMessageChars: 12 })).resolves.toEqual({
      summary: "The visitor asks about an October invoice.",
      messages: ["Hallo", "Wo ist meine"],
      withheldCount: 0,
    });
    expect(listRecentByConversationId).toHaveBeenCalledWith(workspaceId, conversationId, 6, { roles: ["user"], answeredOnly: true });
  });

  it("leaves out a message of a turn whose routine held a sensitive slot, and a teammate's message", async () => {
    const { reader } = readerWith({
      messages: [
        message("I have a heart condition", { metadata: sensitiveTurnMetadata(["condition"]) }),
        message("Sent by a teammate", { source: "human_agent" }),
        message("Can I book for Tuesday?"),
      ],
    });

    await expect(reader.readExcerpt({ workspaceId, conversationId, maxMessages: 6, maxMessageChars: 1_000 })).resolves.toEqual({
      summary: null,
      messages: ["Can I book for Tuesday?"],
      withheldCount: 1,
    });
  });

  it("reads nothing for a conversation that is gone", async () => {
    const { reader, listRecentByConversationId } = readerWith({ messages: [message("Hi")], conversation: false });

    await expect(reader.readExcerpt({ workspaceId, conversationId, maxMessages: 6, maxMessageChars: 1_000 })).resolves.toBeNull();
    expect(listRecentByConversationId).not.toHaveBeenCalled();
  });
});
