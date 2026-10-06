import { describe, expect, it, vi } from "vitest";

import { createPostgresOwnershipChangeUnitOfWork } from "../../../src/app/composition/conversationOwnershipChanges.js";
import { createPostgresOwnershipReplyUnitOfWork } from "../../../src/app/composition/conversationOwnershipReplies.js";
import { ConversationActivityRepository } from "../../../src/db/repositories/conversationActivityRepository.js";
import { createRecordingKysely } from "../../support/recordingKysely.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";

/** What Postgres raises on the transaction it picks as a deadlock's victim. */
const deadlock = (): Error => Object.assign(new Error("deadlock detected"), { code: "40P01" });

const kindOf = (sql: string): string | null => {
  if (/^select "id" from "conversations" .*for no key update$/u.test(sql)) return "lock_conversation";
  if (/^insert into "routine_action_requests"/u.test(sql)) return "enqueue";
  return null;
};

const harness = () => {
  const { db, log } = createRecordingKysely(({ sql, parameters }) => {
    switch (kindOf(sql)) {
      case "lock_conversation":
        return { rows: [{ id: parameters[0] }] };
      case "enqueue":
        return { rows: [{ id: "action-1" }] };
      default:
        return undefined;
    }
  });
  const deps = {
    db,
    activity: new ConversationActivityRepository(db),
    actionDrain: { requestDrain: vi.fn(async () => undefined) },
    logger: { warn: vi.fn() },
  };
  const sent = () => log.map((entry) => (["BEGIN", "COMMIT", "ROLLBACK"].includes(entry) ? entry : kindOf(entry) ?? entry));
  return { deps, sent };
};

const accountId = "33333333-3333-4333-8333-333333333333";
const notice = { type: "conversation.transfer_notice", payload: {}, accountId, workspaceId, conversationId, idempotencyKey: "notice-1" };

describe("ownership units of work", () => {
  it("runs a claim's whole transaction again when Postgres aborted it as a deadlock victim, conversation lock first each time", async () => {
    const { deps, sent } = harness();
    let attempts = 0;

    const result = await createPostgresOwnershipChangeUnitOfWork(deps).run(async ({ conversations, outbox }) => {
      attempts += 1;
      await conversations.lockForUpdate(conversationId, workspaceId);
      if (attempts === 1) {
        await outbox.enqueue(notice);
        throw deadlock();
      }
      return "claimed";
    });

    expect(result).toBe("claimed");
    expect(sent()).toEqual(["BEGIN", "lock_conversation", "enqueue", "ROLLBACK", "BEGIN", "lock_conversation", "COMMIT"]);
    expect(deps.logger.warn).toHaveBeenCalledExactlyOnceWith(
      { unit: "conversation_ownership_change", attempt: 1, maxAttempts: 3 },
      "transaction_deadlock_retried",
    );
    // The aborted attempt's notice never committed, so there is nothing to drain.
    expect(deps.actionDrain.requestDrain).not.toHaveBeenCalled();
  });

  it("runs a reply's whole transaction again when Postgres aborted it as a deadlock victim, pushing the drain only for what committed", async () => {
    const { deps, sent } = harness();
    let attempts = 0;

    const result = await createPostgresOwnershipReplyUnitOfWork(deps).run(async ({ conversations, reply }) => {
      attempts += 1;
      await conversations.lockForUpdate(conversationId, workspaceId);
      await reply.outbox.enqueue(notice);
      if (attempts === 1) throw deadlock();
      return "replied";
    });

    expect(result).toBe("replied");
    expect(sent()).toEqual(["BEGIN", "lock_conversation", "enqueue", "ROLLBACK", "BEGIN", "lock_conversation", "enqueue", "COMMIT"]);
    expect(deps.logger.warn).toHaveBeenCalledExactlyOnceWith(
      { unit: "conversation_ownership_reply", attempt: 1, maxAttempts: 3 },
      "transaction_deadlock_retried",
    );
    expect(deps.actionDrain.requestDrain).toHaveBeenCalledTimes(1);
  });

  it("never runs an ownership change again on any other failure", async () => {
    const { deps, sent } = harness();

    await expect(createPostgresOwnershipChangeUnitOfWork(deps).run(async ({ conversations }) => {
      await conversations.lockForUpdate(conversationId, workspaceId);
      throw Object.assign(new Error("unique violation"), { code: "23505" });
    })).rejects.toThrow("unique violation");

    expect(sent()).toEqual(["BEGIN", "lock_conversation", "ROLLBACK"]);
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });
});
