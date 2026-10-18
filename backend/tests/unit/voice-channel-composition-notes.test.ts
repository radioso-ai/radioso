import { describe, expect, it, vi } from "vitest";

import { createVoiceStoredReplyReader, createVoiceTurnNotes } from "../../src/app/composition/voiceChannel.js";
import type { AuditEventInput } from "../../src/modules/audit/contracts/index.js";

const note = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  assistantMessageId: "message-1",
  heardCharacterCount: 12,
  spokenCharacterCount: 40,
};

const sinks = (options: { markFails?: boolean; replyFound?: boolean } = {}) => {
  const writes: string[] = [];
  const audits: AuditEventInput[] = [];
  const logger = { warn: vi.fn() };
  const notes = createVoiceTurnNotes({
    replies: {
      markReplyInterrupted: async (input) => {
        writes.push(`mark:${input.messageId}:${input.heardCharacterCount}/${input.spokenCharacterCount}`);
        if (options.markFails) {
          throw new Error("database unavailable");
        }
        return options.replyFound ?? true;
      },
    },
    auditService: {
      record: async (event) => {
        writes.push(`audit:${event.eventType}`);
        audits.push(event);
      },
    },
    logger,
  });
  return { notes, writes, audits, logger };
};

describe("voice channel composition: turn notes", () => {
  it("marks the stored reply before recording the interruption audit event, whose metadata names no text", async () => {
    const { notes, writes, audits } = sinks();

    await notes.replyInterrupted(note);

    expect(writes).toEqual(["mark:message-1:12/40", "audit:voice.reply_interrupted"]);
    expect(audits).toEqual([{
      workspaceId: "workspace-1",
      eventType: "voice.reply_interrupted",
      eventStatus: "success",
      metadata: {
        conversationId: "conversation-1",
        assistantMessageId: "message-1",
        heardCharacterCount: 12,
        spokenCharacterCount: 40,
        partial: false,
      },
    }]);
  });

  it("rejects the note without an audit event when the reply cannot be marked, so the session retries it", async () => {
    const { notes, writes } = sinks({ markFails: true });

    await expect(notes.replyInterrupted(note)).rejects.toThrow("database unavailable");

    expect(writes).toEqual(["mark:message-1:12/40"]);
  });

  it("records nothing and warns when the conversation holds no such reply, without failing the note", async () => {
    const { notes, writes, logger } = sinks({ replyFound: false });

    await expect(notes.replyInterrupted(note)).resolves.toBeUndefined();

    expect(writes).toEqual(["mark:message-1:12/40"]);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", conversationId: "conversation-1", messageId: "message-1" },
      "Voice reply to mark interrupted was not found",
    );
  });

  it("records a replayed reply as an audit event only", async () => {
    const { notes, writes, audits } = sinks();

    await notes.replyReplayed({ workspaceId: "workspace-1", conversationId: "conversation-1", assistantMessageId: "message-1" });

    expect(writes).toEqual(["audit:voice.reply_replayed"]);
    expect(audits[0]?.metadata).toEqual({ conversationId: "conversation-1", assistantMessageId: "message-1" });
  });

  it("audits a teammate's replies recorded as spoken by id only", async () => {
    const { notes, writes, audits } = sinks();

    await notes.operatorRepliesSpoken({ workspaceId: "workspace-1", conversationId: "conversation-1", messageIds: ["reply-1", "reply-2"] });

    expect(writes).toEqual(["audit:voice.operator_reply_spoken"]);
    expect(audits).toEqual([{
      workspaceId: "workspace-1",
      eventType: "voice.operator_reply_spoken",
      eventStatus: "success",
      metadata: { conversationId: "conversation-1", messageIds: ["reply-1", "reply-2"] },
    }]);
  });
});

describe("voice channel composition: the stored answer a switch's follow-up reads", () => {
  const conversation = { workspaceId: "workspace-1", conversationId: "conversation-1" };
  const readerOver = (messages: Array<{ id: string; role: string; content: string; source?: string }>) => {
    const listRecentByConversationId = vi.fn(async () => messages);
    return { reader: createVoiceStoredReplyReader({ listRecentByConversationId }), listRecentByConversationId };
  };

  it("reads the agent's answer to the newest user message, past a system message", async () => {
    const { reader, listRecentByConversationId } = readerOver([
      { id: "u1", role: "user", content: "A che ora aprite?" },
      { id: "a1", role: "assistant", content: "Apriamo alle nove.", source: "ai_agent" },
      { id: "s1", role: "system", content: "routine note" },
    ]);

    expect(await reader.replyToNewestUtterance(conversation)).toEqual({ messageId: "a1", text: "Apriamo alle nove." });
    expect(listRecentByConversationId).toHaveBeenCalledWith("workspace-1", "conversation-1", 4, { roles: ["user", "assistant"] });
  });

  it("reads nothing while the newest message is the caller's, a teammate's reply, or an empty answer", async () => {
    const pending = readerOver([{ id: "a0", role: "assistant", content: "Ciao." }, { id: "u1", role: "user", content: "A che ora aprite?" }]);
    const teammate = readerOver([{ id: "u1", role: "user", content: "A che ora aprite?" }, { id: "o1", role: "assistant", content: "Sono Marta.", source: "human_agent" }]);
    const empty = readerOver([{ id: "u1", role: "user", content: "A che ora aprite?" }, { id: "a1", role: "assistant", content: "  " }]);

    expect(await pending.reader.replyToNewestUtterance(conversation)).toBeNull();
    expect(await teammate.reader.replyToNewestUtterance(conversation)).toBeNull();
    expect(await empty.reader.replyToNewestUtterance(conversation)).toBeNull();
  });
});
