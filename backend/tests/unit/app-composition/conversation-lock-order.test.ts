import { describe, expect, it, vi } from "vitest";

import {
  lockConversationsInOrder,
  runTransactionWithDeadlockRetry,
} from "../../../src/app/composition/conversationLockOrder.js";
import { createRecordingKysely } from "../../support/recordingKysely.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";

/** What Postgres raises on the transaction it picks as a deadlock's victim. */
const deadlock = (): Error => Object.assign(new Error("deadlock detected"), { code: "40P01" });

const kindOf = (sql: string): string | null => {
  if (/^select "id" from "conversations" .*for no key update$/u.test(sql)) return "lock_conversation";
  if (/FROM conversation_ownership o[\s\S]*FOR UPDATE OF o/u.test(sql)) return "lock_ownership";
  if (/^select 1/u.test(sql)) return "work";
  return null;
};

describe("runTransactionWithDeadlockRetry", () => {
  const harness = (failures: Error[]) => {
    const { db, log, statements } = createRecordingKysely(({ sql }) => {
      if (kindOf(sql) === "work") {
        const failure = failures.shift();
        if (failure) throw failure;
      }
      return undefined;
    });
    const logger = { warn: vi.fn() };
    const run = (maxAttempts?: number) => runTransactionWithDeadlockRetry(db, async (trx) => {
      await trx.selectNoFrom((eb) => eb.lit(1).as("one")).execute();
      return "committed";
    }, { unit: "held_reply", logger, ...(maxAttempts === undefined ? {} : { maxAttempts }) });
    const sent = () => log.map((entry) => (["BEGIN", "COMMIT", "ROLLBACK"].includes(entry) ? entry : kindOf(entry) ?? entry));
    return { run, sent, logger, statements };
  };

  it("runs the work once in one transaction when nothing contends", async () => {
    const { run, sent, logger } = harness([]);

    expect(await run()).toBe("committed");

    expect(sent()).toEqual(["BEGIN", "work", "COMMIT"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("runs the whole transaction again when Postgres aborted it as a deadlock's victim, and says so by unit and attempt", async () => {
    const { run, sent, logger } = harness([deadlock()]);

    expect(await run()).toBe("committed");

    expect(sent()).toEqual(["BEGIN", "work", "ROLLBACK", "BEGIN", "work", "COMMIT"]);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith({ unit: "held_reply", attempt: 1, maxAttempts: 3 }, "transaction_deadlock_retried");
  });

  it("gives up after its bounded attempts, raising the deadlock", async () => {
    const { run, sent } = harness([deadlock(), deadlock()]);

    await expect(run(2)).rejects.toMatchObject({ code: "40P01" });

    expect(sent()).toEqual(["BEGIN", "work", "ROLLBACK", "BEGIN", "work", "ROLLBACK"]);
  });

  it("never runs again on any other failure", async () => {
    const { run, sent, logger } = harness([Object.assign(new Error("unique violation"), { code: "23505" })]);

    await expect(run()).rejects.toThrow("unique violation");

    expect(sent()).toEqual(["BEGIN", "work", "ROLLBACK"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("lockConversationsInOrder", () => {
  it("locks each conversation and then its ownership row, in one order every unit of work shares", async () => {
    const { db, log, statements } = createRecordingKysely(({ sql, parameters }) =>
      (kindOf(sql) === "lock_conversation" ? { rows: [{ id: parameters[0] }] } : undefined));

    const locked = await lockConversationsInOrder(db, workspaceId, ["conversation-b", "conversation-a", "conversation-b"]);

    expect(locked).toEqual(new Set(["conversation-a", "conversation-b"]));
    expect(log.map((entry) => kindOf(entry))).toEqual(["lock_conversation", "lock_ownership", "lock_conversation", "lock_ownership"]);
    expect(statements.map((statement) => statement.parameters[0])).toEqual(["conversation-a", "conversation-a", "conversation-b", "conversation-b"]);
    expect(statements.filter((statement) => kindOf(statement.sql) === "lock_conversation").map((statement) => statement.parameters[1]))
      .toEqual([workspaceId, workspaceId]);
  });

  it("leaves a conversation outside the workspace alone, ownership row included", async () => {
    const { db, log } = createRecordingKysely(() => undefined);

    const locked = await lockConversationsInOrder(db, workspaceId, ["conversation-elsewhere"]);

    expect(locked).toEqual(new Set());
    expect(log.map((entry) => kindOf(entry))).toEqual(["lock_conversation"]);
  });
});
