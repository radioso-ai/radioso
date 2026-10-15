import { describe, expect, it } from "vitest";

import { createVoiceTurnNotes } from "../../src/app/composition/voiceChannel.js";
import type { AuditEventInput } from "../../src/modules/audit/contracts/index.js";

const note = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  assistantMessageId: "message-1",
  heardCharacterCount: 12,
  spokenCharacterCount: 40,
};

const sinks = (options: { markFails?: boolean } = {}) => {
  const writes: string[] = [];
  const audits: AuditEventInput[] = [];
  const notes = createVoiceTurnNotes({
    replies: {
      markReplyInterrupted: async (input) => {
        writes.push(`mark:${input.messageId}:${input.heardCharacterCount}/${input.spokenCharacterCount}`);
        if (options.markFails) {
          throw new Error("database unavailable");
        }
      },
    },
    auditService: {
      record: async (event) => {
        writes.push(`audit:${event.eventType}`);
        audits.push(event);
      },
    },
  });
  return { notes, writes, audits };
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

  it("records a replayed reply as an audit event only", async () => {
    const { notes, writes, audits } = sinks();

    await notes.replyReplayed({ workspaceId: "workspace-1", conversationId: "conversation-1", assistantMessageId: "message-1" });

    expect(writes).toEqual(["audit:voice.reply_replayed"]);
    expect(audits[0]?.metadata).toEqual({ conversationId: "conversation-1", assistantMessageId: "message-1" });
  });
});
