import { describe, expect, it, vi } from "vitest";

import { closeDependencies, type ClosableDependencies } from "../../src/app/server/closeDependencies.js";

/** A composition whose closers record their order, one of them failing when `failing` names it. */
const composition = (closed: string[], failing: readonly string[] = []) => {
  const step = (name: string) => async (): Promise<void> => {
    closed.push(name);
    if (failing.includes(name)) {
      throw new Error(`${name} failed`);
    }
  };
  const logger = { error: vi.fn() };
  const dependencies = {
    realtimePublisherLifecycle: { shutdown: step("realtime publisher") },
    applicationModules: { shutdownAll: step("application modules") },
    closeApprovalResumeEffectJournal: step("approval journal"),
    closeAbuseControlRepository: step("abuse control"),
    connectorRegistry: { shutdownAll: step("connectors") },
    logger,
  } as unknown as ClosableDependencies;
  return { dependencies, logger };
};

const ORDER = ["realtime publisher", "application modules", "approval journal", "abuse control", "connectors"];

describe("closeDependencies", () => {
  it("closes what the composition opened in the runtimes' order", async () => {
    const closed: string[] = [];

    await closeDependencies(composition(closed).dependencies);

    expect(closed).toEqual(ORDER);
  });

  it("runs every step after one fails, logs each failure with its step, and rethrows the first", async () => {
    const closed: string[] = [];
    const { dependencies, logger } = composition(closed, ["realtime publisher", "approval journal"]);

    await expect(closeDependencies(dependencies)).rejects.toThrow("realtime publisher failed");
    expect(closed).toEqual(ORDER);
    expect(logger.error.mock.calls.map(([fields]) => (fields as { step: string }).step))
      .toEqual(["realtime publisher", "approval resume effect journal"]);
  });
});
