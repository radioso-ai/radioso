import { describe, expect, it } from "vitest";

import { NormalizationSlots } from "../../../../src/shared/infra/images/normalizationSlots.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("NormalizationSlots", () => {
  it("runs at most its limit at once, and hands a freed slot to the next waiting", async () => {
    const slots = new NormalizationSlots(2, 1_000);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((gate, index) => slots.run(async () => { started.push(index); await gate.promise; return index; }));

    await tick();
    expect(started).toEqual([0, 1]);

    gates[0].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve();
    gates[2].resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
  });

  it("refuses work that waits past its limit, and runs none of it", async () => {
    const slots = new NormalizationSlots(1, 5);
    const gate = deferred();
    const holding = slots.run(() => gate.promise);
    let ran = false;

    expect(await slots.run(async () => { ran = true; })).toBe("busy");

    expect(ran).toBe(false);
    gate.resolve();
    await holding;
    expect(await slots.run(async () => "free again")).toBe("free again");
  });

  it("waits only as long as a caller allows, when that is shorter than the pool's own wait", async () => {
    const slots = new NormalizationSlots(1, 5_000);
    const gate = deferred();
    const holding = slots.run(() => gate.promise);
    const startedAt = Date.now();

    expect(await slots.run(async () => "ran", { waitMs: 5 })).toBe("busy");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    gate.resolve();
    await holding;
  });

  it("frees the slot when the work fails", async () => {
    const slots = new NormalizationSlots(1, 5);

    await expect(slots.run(async () => { throw new Error("decode failed"); })).rejects.toThrow("decode failed");

    expect(await slots.run(async () => "next")).toBe("next");
  });
});
