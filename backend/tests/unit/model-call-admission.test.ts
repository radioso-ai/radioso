import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ModelCallAdmission,
  ModelCallShedError,
  type ModelCallAdmissionObserver,
} from "../../src/shared/infra/llm/modelCallAdmission.js";
import { isReportableFault } from "../../src/shared/domain/errors.js";

const limits = { maxConcurrentTurnCalls: 2, maxConcurrentDeferrableCalls: 1, maxQueueWaitMs: 1_000 };

const observer = () => ({
  inFlight: vi.fn<ModelCallAdmissionObserver["inFlight"]>(),
  queued: vi.fn<ModelCallAdmissionObserver["queued"]>(),
  shed: vi.fn<ModelCallAdmissionObserver["shed"]>(),
});

describe("ModelCallAdmission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("admits turn calls up to the cap, then sheds the next with a typed busy failure once the queue wait runs out", async () => {
    const events = observer();
    const admission = new ModelCallAdmission(limits, events);
    await admission.acquire({ lane: "turn" });
    await admission.acquire({ lane: "turn" });

    const third = admission.acquire({ lane: "turn" });
    const settled = expect(third).rejects.toMatchObject({ statusCode: 503, code: "model_capacity_busy", reason: "queue_timeout" });
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    expect(events.shed).toHaveBeenCalledWith("turn", "queue_timeout");
  });

  it("hands a freed permit to the call waiting longest", async () => {
    const events = observer();
    const admission = new ModelCallAdmission(limits, events);
    const releaseFirst = await admission.acquire({ lane: "turn" });
    await admission.acquire({ lane: "turn" });

    let admitted = false;
    const waiting = admission.acquire({ lane: "turn" }).then((release) => {
      admitted = true;
      return release;
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(admitted).toBe(false);

    releaseFirst();
    await waiting;
    expect(admitted).toBe(true);
    expect(events.queued).toHaveBeenCalledWith("turn", 400);
  });

  it("counts a permit released twice only once", async () => {
    const admission = new ModelCallAdmission(limits);
    const release = await admission.acquire({ lane: "turn" });
    await admission.acquire({ lane: "turn" });
    release();
    release();

    await admission.acquire({ lane: "turn" });
    const overCap = admission.acquire({ lane: "turn" });
    const settled = expect(overCap).rejects.toBeInstanceOf(ModelCallShedError);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
  });

  it("keeps deferrable work on its own budget, so it can never take a turn's permit", async () => {
    const admission = new ModelCallAdmission(limits);
    await admission.acquire({ lane: "deferrable" });

    // The deferrable lane is full and never queues: the next deferrable call is shed at once.
    await expect(admission.acquire({ lane: "deferrable" })).rejects.toMatchObject({ lane: "deferrable", reason: "lane_full" });

    // Turn calls still get every one of their permits.
    await admission.acquire({ lane: "turn" });
    await admission.acquire({ lane: "turn" });
  });

  it("never lets a burst of turn calls starve on deferrable work, nor the reverse", async () => {
    const admission = new ModelCallAdmission(limits);
    await admission.acquire({ lane: "turn" });
    await admission.acquire({ lane: "turn" });

    await expect(admission.acquire({ lane: "deferrable" })).resolves.toEqual(expect.any(Function));
  });

  it("sheds an abandoned turn's call at once when the lane is full, instead of queueing it ahead of a live visitor", async () => {
    const admission = new ModelCallAdmission(limits);
    await admission.acquire({ lane: "turn" });
    await admission.acquire({ lane: "turn" });
    const clientGone = new AbortController();
    clientGone.abort();

    await expect(admission.acquire({ lane: "turn", abandoned: clientGone.signal }))
      .rejects.toMatchObject({ reason: "abandoned" });
  });

  it("still admits an abandoned turn's call while there is room, so the visitor finds the answer later", async () => {
    const admission = new ModelCallAdmission(limits);
    const clientGone = new AbortController();
    clientGone.abort();

    await expect(admission.acquire({ lane: "turn", abandoned: clientGone.signal })).resolves.toEqual(expect.any(Function));
  });

  it("drops a queued call whose visitor leaves while it waits", async () => {
    const admission = new ModelCallAdmission(limits);
    await admission.acquire({ lane: "turn" });
    await admission.acquire({ lane: "turn" });
    const clientGone = new AbortController();

    const waiting = admission.acquire({ lane: "turn", abandoned: clientGone.signal });
    const settled = expect(waiting).rejects.toMatchObject({ reason: "abandoned" });
    clientGone.abort();
    await settled;
  });

  it("rejects a queued call with the caller's own reason when its turn is cancelled", async () => {
    const admission = new ModelCallAdmission(limits);
    await admission.acquire({ lane: "turn" });
    await admission.acquire({ lane: "turn" });
    const turn = new AbortController();

    const waiting = admission.acquire({ lane: "turn", signal: turn.signal });
    const settled = expect(waiting).rejects.toThrow("superseded");
    turn.abort(new Error("superseded"));
    await settled;
  });

  it("reports the lane's in-flight count as permits come and go", async () => {
    const events = observer();
    const admission = new ModelCallAdmission(limits, events);
    const release = await admission.acquire({ lane: "turn" });
    release();

    expect(events.inFlight.mock.calls).toEqual([["turn", 1], ["turn", 0]]);
  });

  it("treats shedding as an expected outcome, not a fault for error tracking", () => {
    expect(isReportableFault(new ModelCallShedError("turn", "queue_timeout"))).toBe(false);
  });
});
