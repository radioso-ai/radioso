import { describe, expect, it, vi } from "vitest";

import { createVoiceTurnNotes } from "../../src/app/composition/voiceChannel.js";
import type { AuditEventInput } from "../../src/modules/audit/contracts/index.js";

const note = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  assistantMessageId: "message-1",
  heardCharacterCount: 12,
  spokenCharacterCount: 40,
};

const sinks = (options: { markFails?: boolean; replyFound?: boolean; alreadySpoken?: string[] } = {}) => {
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
      markOperatorRepliesSpoken: async (input) => {
        writes.push(`spoken:${input.conversationId}:${input.messageIds.join(",")}`);
        if (options.markFails) {
          throw new Error("database unavailable");
        }
        return input.messageIds.filter((messageId) => !(options.alreadySpoken ?? []).includes(messageId));
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

  describe("a teammate's replies spoken to the caller", () => {
    const spoken = { workspaceId: "workspace-1", conversationId: "conversation-1", messageIds: ["reply-1", "reply-2"] };

    it("marks the replies spoken before recording one audit event that names them by id only", async () => {
      const { notes, writes, audits } = sinks();

      await notes.operatorRepliesSpoken(spoken);

      expect(writes).toEqual(["spoken:conversation-1:reply-1,reply-2", "audit:voice.operator_reply_spoken"]);
      expect(audits).toEqual([{
        workspaceId: "workspace-1",
        eventType: "voice.operator_reply_spoken",
        eventStatus: "success",
        metadata: { conversationId: "conversation-1", messageIds: ["reply-1", "reply-2"] },
      }]);
    });

    it("audits only the replies this note marked, and nothing when another turn marked them all first", async () => {
      const some = sinks({ alreadySpoken: ["reply-1"] });
      await some.notes.operatorRepliesSpoken(spoken);
      expect(some.audits.map((event) => event.metadata)).toEqual([{ conversationId: "conversation-1", messageIds: ["reply-2"] }]);

      const none = sinks({ alreadySpoken: ["reply-1", "reply-2"] });
      await expect(none.notes.operatorRepliesSpoken(spoken)).resolves.toBeUndefined();
      expect(none.writes).toEqual(["spoken:conversation-1:reply-1,reply-2"]);
    });

    it("rejects the note without an audit event when the replies cannot be marked", async () => {
      const { notes, writes } = sinks({ markFails: true });

      await expect(notes.operatorRepliesSpoken(spoken)).rejects.toThrow("database unavailable");

      expect(writes).toEqual(["spoken:conversation-1:reply-1,reply-2"]);
    });
  });
});
