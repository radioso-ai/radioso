import { describe, expect, it, vi } from "vitest";

import {
  IDENTITY_NONCE_PRUNE_BATCH_SIZE,
  IDENTITY_NONCE_PRUNE_MAX_BATCHES_PER_RUN,
  identityNoncePrunePeriodicTask,
} from "../../src/app/composition/identityNoncePrune.js";

const now = new Date("2026-11-13T10:00:00.000Z");

const run = async (deleteExpired: (at: Date, limit: number) => Promise<number>) => {
  const logger = { info: vi.fn() };
  const task = identityNoncePrunePeriodicTask({ nonces: { deleteExpired }, logger, clock: () => now });
  await task.handle.run();
  return { task, logger };
};

describe("identity nonce prune task", () => {
  it("is registered under the id the worker's task route and the scheduler call it by", async () => {
    const { task } = await run(async () => 0);

    expect(task.id).toBe("identity-nonce-prune");
    expect(task.intervalMs).toBe(15 * 60 * 1_000);
  });

  it("deletes the nonces whose verification window has passed, in a bounded batch", async () => {
    const deleteExpired = vi.fn(async () => 3);

    const { logger } = await run(deleteExpired);

    expect(deleteExpired).toHaveBeenCalledTimes(1);
    expect(deleteExpired).toHaveBeenCalledWith(now, IDENTITY_NONCE_PRUNE_BATCH_SIZE);
    expect(logger.info).toHaveBeenCalledWith({ removed: 3 }, expect.any(String));
  });

  it("keeps deleting while batches come back full, and stops at the cap so one run stays short", async () => {
    const deleteExpired = vi.fn(async () => IDENTITY_NONCE_PRUNE_BATCH_SIZE);

    const { logger } = await run(deleteExpired);

    expect(deleteExpired).toHaveBeenCalledTimes(IDENTITY_NONCE_PRUNE_MAX_BATCHES_PER_RUN);
    expect(logger.info).toHaveBeenCalledWith(
      { removed: IDENTITY_NONCE_PRUNE_BATCH_SIZE * IDENTITY_NONCE_PRUNE_MAX_BATCHES_PER_RUN },
      expect.any(String),
    );
  });

  it("stops at the first short batch", async () => {
    const batches = [IDENTITY_NONCE_PRUNE_BATCH_SIZE, 17];
    const deleteExpired = vi.fn(async () => batches.shift() ?? 0);

    const { logger } = await run(deleteExpired);

    expect(deleteExpired).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith({ removed: IDENTITY_NONCE_PRUNE_BATCH_SIZE + 17 }, expect.any(String));
  });

  it("logs nothing when there was nothing to delete", async () => {
    const { logger } = await run(async () => 0);

    expect(logger.info).not.toHaveBeenCalled();
  });

  it("lets a failed delete reject, so a scheduled call is reported as failed", async () => {
    const task = identityNoncePrunePeriodicTask({
      nonces: { deleteExpired: async () => { throw new Error("database unavailable"); } },
      logger: { info: vi.fn() },
    });

    await expect(task.handle.run()).rejects.toThrow("database unavailable");
  });
});
