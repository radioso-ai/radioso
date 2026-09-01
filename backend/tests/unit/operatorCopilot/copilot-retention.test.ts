import { describe, expect, it, vi } from "vitest";

import {
  COPILOT_CONVERSATION_RETENTION_DAYS_DEFAULT,
  CopilotRetentionWorker,
} from "../../../src/modules/operatorCopilot/public.js";

const now = new Date("2026-08-31T12:00:00.000Z");

const harness = (options: {
  retentionDays?: number;
  batchSize?: number;
  deletedPerBatch?: ReadonlyArray<number>;
} = {}) => {
  const batches = [...(options.deletedPerBatch ?? [0])];
  const deleteConversationsUpdatedBefore = vi.fn(async (_input: { cutoff: Date; limit: number }) => batches.shift() ?? 0);
  const record = vi.fn(async () => {});
  const warn = vi.fn();
  const info = vi.fn();
  const worker = new CopilotRetentionWorker({
    retention: { deleteConversationsUpdatedBefore },
    audit: { record },
    logger: { info, warn, error: vi.fn() },
    retentionDays: options.retentionDays ?? 90,
    batchSize: options.batchSize ?? 200,
    now: () => now,
  });
  return { worker, deleteConversationsUpdatedBefore, record, info, warn };
};

describe("CopilotRetentionWorker", () => {
  it("deletes conversations whose last activity is older than the retention window", async () => {
    const { worker, deleteConversationsUpdatedBefore } = harness({ retentionDays: 30, deletedPerBatch: [7] });

    const result = await worker.sweep();

    expect(deleteConversationsUpdatedBefore).toHaveBeenCalledWith({
      cutoff: new Date("2026-08-01T12:00:00.000Z"),
      limit: 200,
    });
    expect(result).toEqual({ status: "swept", deleted: 7 });
  });

  it("keeps deleting while a batch comes back full, so a backlog drains without one unbounded statement", async () => {
    const { worker, deleteConversationsUpdatedBefore } = harness({ batchSize: 2, deletedPerBatch: [2, 2, 1] });

    const result = await worker.sweep();

    expect(deleteConversationsUpdatedBefore).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ status: "swept", deleted: 5 });
  });

  it("records what it removed so a vanished copilot conversation is explainable", async () => {
    const { worker, record } = harness({ retentionDays: 30, deletedPerBatch: [4] });

    await worker.sweep();

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "copilot.retention.enforced",
      eventStatus: "success",
      // Says system rather than leaving the actor absent: every other copilot.* event names an
      // operator and a surface, so a silent gap here would read as attribution that went missing.
      metadata: expect.objectContaining({ deleted: 4, retentionDays: 30, principalType: "system" }),
    }));
  });

  it("stays silent when a sweep finds nothing, rather than auditing every idle tick", async () => {
    const { worker, record } = harness({ deletedPerBatch: [0] });

    await worker.sweep();

    expect(record).not.toHaveBeenCalled();
  });

  it("does nothing at all when retention is switched off", async () => {
    const { worker, deleteConversationsUpdatedBefore } = harness({ retentionDays: 0 });

    worker.start();
    const result = await worker.sweep();
    await worker.stop();

    expect(result).toEqual({ status: "skipped", reason: "disabled" });
    expect(deleteConversationsUpdatedBefore).not.toHaveBeenCalled();
  });

  it("reports the sweep as done but logs loudly when the audit write fails after the delete", async () => {
    const deleteConversationsUpdatedBefore = vi.fn(async () => 3);
    const error = vi.fn();
    const worker = new CopilotRetentionWorker({
      retention: { deleteConversationsUpdatedBefore },
      audit: { record: vi.fn(async () => { throw new Error("audit sink down"); }) },
      logger: { info: vi.fn(), warn: vi.fn(), error },
      retentionDays: 90,
      batchSize: 10,
      now: () => now,
    });

    // The rows are already gone, so the sweep did happen; the missing record is the problem, and
    // it has to be visible rather than swallowed.
    await expect(worker.sweep()).resolves.toEqual({ status: "swept", deleted: 3 });
    expect(error).toHaveBeenCalled();
  });

  it("keeps the loop alive when one sweep throws", async () => {
    const deleteConversationsUpdatedBefore = vi.fn(async () => { throw new Error("deadlock"); });
    const error = vi.fn();
    const worker = new CopilotRetentionWorker({
      retention: { deleteConversationsUpdatedBefore },
      audit: { record: vi.fn(async () => {}) },
      logger: { info: vi.fn(), warn: vi.fn(), error },
      retentionDays: 90,
      batchSize: 10,
      now: () => now,
    });

    // Reported rather than swallowed: the scheduled task route turns this into a retry, and a
    // failure indistinguishable from a quiet tick is a retention window that stops being enforced.
    await expect(worker.sweep()).resolves.toEqual({ status: "failed", error: "deadlock" });
    expect(error).toHaveBeenCalled();
  });

  it("does not run two sweeps at once", async () => {
    let release: (() => void) | undefined;
    const deleteConversationsUpdatedBefore = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return 0;
    });
    const worker = new CopilotRetentionWorker({
      retention: { deleteConversationsUpdatedBefore },
      audit: { record: vi.fn(async () => {}) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      retentionDays: 90,
      batchSize: 10,
      now: () => now,
    });

    const first = worker.sweep();
    const second = await worker.sweep();
    release?.();
    await first;

    expect(second).toEqual({ status: "skipped", reason: "in_flight" });
    expect(deleteConversationsUpdatedBefore).toHaveBeenCalledOnce();
  });

  it("defaults to a window long enough to keep recent operator work", () => {
    expect(COPILOT_CONVERSATION_RETENTION_DAYS_DEFAULT).toBeGreaterThanOrEqual(30);
  });
});
