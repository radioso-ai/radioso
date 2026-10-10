import { describe, expect, it, vi } from "vitest";

import { createPostgresConversationIngestUnitOfWork } from "../../../src/app/composition/conversationIngest.js";
import { createRecordingKysely } from "../../support/recordingKysely.js";

const kindOf = (sql: string): string | null => {
  if (/FROM conversation_ownership o[\s\S]*FOR UPDATE OF o/u.test(sql)) return "lock_ownership";
  if (/^update "held_replies" set .*"superseded_reason"/u.test(sql)) return "supersede_held_replies";
  return null;
};

describe("createPostgresConversationIngestUnitOfWork", () => {
  it("locks the conversation's ownership row before the drafts a customer's newer message supersedes, the lock protocol's order", async () => {
    const { db, log } = createRecordingKysely(({ sql }) => (kindOf(sql) === "supersede_held_replies" ? { changed: 1 } : undefined));
    const unitOfWork = createPostgresConversationIngestUnitOfWork({ db, activity: { record: vi.fn() } });

    const superseded = await unitOfWork.run((scope) => scope.heldReplies.supersedePendingForConversation("conversation-1", "newer_inbound"));

    expect(superseded).toBe(1);
    expect(log.map((entry) => (["BEGIN", "COMMIT", "ROLLBACK"].includes(entry) ? entry : kindOf(entry) ?? entry)))
      .toEqual(["BEGIN", "lock_ownership", "supersede_held_replies", "COMMIT"]);
  });
});
