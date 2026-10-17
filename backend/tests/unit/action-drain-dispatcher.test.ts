import { describe, expect, it, vi } from "vitest";

// `NoopActionDrainDispatcher` is now `NoopBackgroundJobWake` (#1509); it already has its own
// coverage in `tests/unit/default-composition.test.ts` and the background-jobs suite, so this
// file keeps only the `DrainTriggeringActionOutbox` tests that cover action-outbox behaviour.
describe("DrainTriggeringActionOutbox", () => {
  it("enqueues through the inner outbox, then requests a drain", async () => {
    const { DrainTriggeringActionOutbox } = await import(
      "../../src/modules/chat/services/actions/drainTriggeringActionOutbox.js"
    );
    const calls: string[] = [];
    const inner = {
      enqueue: vi.fn(async (_input: unknown) => {
        calls.push("enqueue");
        return { id: "row_1", duplicate: false };
      }),
    };
    const drainDispatcher = {
      requestDrain: vi.fn(async () => {
        calls.push("requestDrain");
      }),
    };
    const outbox = new DrainTriggeringActionOutbox(inner, drainDispatcher);

    const result = await outbox.enqueue({ type: "contact.send", payload: { email: "a@example.com" } });

    expect(result).toEqual({ id: "row_1", duplicate: false });
    expect(inner.enqueue).toHaveBeenCalledWith({ type: "contact.send", payload: { email: "a@example.com" } });
    // Push happens only after the (auto-committing, single-statement) enqueue resolved.
    expect(calls).toEqual(["enqueue", "requestDrain"]);
  });

  it("propagates an enqueue failure without requesting a drain", async () => {
    const { DrainTriggeringActionOutbox } = await import(
      "../../src/modules/chat/services/actions/drainTriggeringActionOutbox.js"
    );
    const inner = { enqueue: vi.fn(async () => { throw new Error("db down"); }) };
    const drainDispatcher = { requestDrain: vi.fn(async () => {}) };
    const outbox = new DrainTriggeringActionOutbox(inner, drainDispatcher);

    await expect(outbox.enqueue({ type: "contact.send", payload: {} })).rejects.toThrow("db down");
    expect(drainDispatcher.requestDrain).not.toHaveBeenCalled();
  });

  it("swallows a push failure so the caller's enqueue still succeeds", async () => {
    const { DrainTriggeringActionOutbox } = await import(
      "../../src/modules/chat/services/actions/drainTriggeringActionOutbox.js"
    );
    const inner = { enqueue: vi.fn(async () => ({ id: "row_2", duplicate: false })) };
    const drainDispatcher = { requestDrain: vi.fn(async () => { throw new Error("cloud tasks unreachable"); }) };
    const logger = { warn: vi.fn() };
    const outbox = new DrainTriggeringActionOutbox(inner, drainDispatcher, logger);

    await expect(outbox.enqueue({ type: "contact.send", payload: {} })).resolves.toEqual({
      id: "row_2",
      duplicate: false,
    });
    expect(logger.warn).toHaveBeenCalled();
  });
});
