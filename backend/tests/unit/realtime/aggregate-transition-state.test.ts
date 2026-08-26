import { describe, expect, it } from "vitest";
import { AggregateTransitionState } from "../../../src/modules/realtime/infrastructure/aggregateTransitionState.js";

describe("AggregateTransitionState", () => {
  it("reconciles every lost decrement one CAS step at a time", () => {
    const state = new AggregateTransitionState();
    for (let index = 0; index < 5; index += 1) state.acquired();
    expect([state.released(), state.released(), state.released(), state.released()]).toEqual([4, 3, 2, 1]);
    expect(state.localDesired).toBe(1);
    expect(state.nextTarget).toBe(4);
    state.acknowledgeStep();
    expect(state.redisExpected).toBe(4);
    expect(state.nextTarget).toBe(3);
    state.acknowledgeStep();
    state.acknowledgeStep();
    state.acknowledgeStep();
    expect(state.redisExpected).toBe(1);
  });
});
