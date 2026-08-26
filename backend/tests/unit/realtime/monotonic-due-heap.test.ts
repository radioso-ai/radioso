import { describe, expect, it } from "vitest";
import { MonotonicDueHeap } from "../../../src/modules/realtime/infrastructure/monotonicDueHeap.js";

describe("MonotonicDueHeap", () => {
  it("returns due work in ascending order without scanning unrelated entries", () => {
    const heap = new MonotonicDueHeap<{ dueAtMs: number; id: string }>();
    heap.push({ dueAtMs: 30, id: "late" });
    heap.push({ dueAtMs: 10, id: "first" });
    heap.push({ dueAtMs: 20, id: "middle" });
    expect(heap.peek()).toMatchObject({ id: "first" });
    expect([heap.pop()?.id, heap.pop()?.id, heap.pop()?.id]).toEqual(["first", "middle", "late"]);
    expect(heap.pop()).toBeUndefined();
  });
});
