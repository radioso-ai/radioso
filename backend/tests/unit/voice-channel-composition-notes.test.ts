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
  type Row = { id: string; role: "user" | "assistant" | "system"; content: string; source?: string; createdAt: Date };
  const at = (second: number) => new Date(Date.UTC(2026, 9, 19, 10, 0, second));
  /** The message store as it lists a conversation's newest rows of the roles asked for, oldest first. */
  const readerOver = (rows: Row[]) => {
    const listRecentByConversationId = vi.fn(async (_workspaceId: string, _conversationId: string, limit: number, options?: { roles?: readonly string[] }) =>
      rows.filter((row) => !options?.roles || options.roles.includes(row.role)).slice(-limit));
    return { reader: createVoiceStoredReplyReader({ listRecentByConversationId }), listRecentByConversationId };
  };

  it("reads the newest user message on its own and the agent's answer after it", async () => {
    const { reader, listRecentByConversationId } = readerOver([
      { id: "u0", role: "user", content: "Ciao", createdAt: at(1) },
      { id: "a0", role: "assistant", content: "Ciao!", source: "ai_agent", createdAt: at(2) },
      { id: "u1", role: "user", content: "A che ora aprite?", createdAt: at(3) },
      { id: "a1", role: "assistant", content: "Apriamo alle nove.", source: "ai_agent", createdAt: at(5) },
      { id: "s1", role: "system", content: "routine note", createdAt: at(6) },
    ]);

    expect(await reader.newestExchange(conversation)).toEqual({ utterance: "A che ora aprite?", reply: { messageId: "a1", text: "Apriamo alle nove." } });
    expect(listRecentByConversationId).toHaveBeenCalledWith("workspace-1", "conversation-1", 1, { roles: ["user"] });
  });

  it("finds the agent's answer past three teammate replies written after the caller's message", async () => {
    const { reader } = readerOver([
      { id: "u1", role: "user", content: "A che ora aprite?", createdAt: at(3) },
      { id: "o1", role: "assistant", content: "Sono Marta.", source: "human_agent", createdAt: at(4) },
      { id: "o2", role: "assistant", content: "Un attimo.", source: "human_agent", createdAt: at(5) },
      { id: "o3", role: "assistant", content: "Eccomi.", source: "human_agent", createdAt: at(6) },
      { id: "a1", role: "assistant", content: "Apriamo alle nove.", source: "ai_agent", createdAt: at(7) },
    ]);

    expect(await reader.newestExchange(conversation)).toEqual({ utterance: "A che ora aprite?", reply: { messageId: "a1", text: "Apriamo alle nove." } });
  });

  it("reads no answer while there is only the caller's message, a teammate's reply, an empty answer or an earlier one", async () => {
    const utterance = { id: "u1", role: "user" as const, content: "A che ora aprite?", createdAt: at(3) };
    const pending = readerOver([{ id: "a0", role: "assistant", content: "Ciao.", createdAt: at(1) }, utterance]);
    const teammate = readerOver([utterance, { id: "o1", role: "assistant", content: "Sono Marta.", source: "human_agent", createdAt: at(4) }]);
    const empty = readerOver([utterance, { id: "a1", role: "assistant", content: "  ", createdAt: at(4) }]);
    const none = readerOver([{ id: "a0", role: "assistant", content: "Ciao.", createdAt: at(1) }]);

    expect(await pending.reader.newestExchange(conversation)).toEqual({ utterance: "A che ora aprite?", reply: null });
    expect(await teammate.reader.newestExchange(conversation)).toEqual({ utterance: "A che ora aprite?", reply: null });
    expect(await empty.reader.newestExchange(conversation)).toEqual({ utterance: "A che ora aprite?", reply: null });
    expect(await none.reader.newestExchange(conversation)).toBeNull();
  });
});
