import { describe, expect, it } from "vitest";

import {
  commitDirectiveFirings,
  emptyDirectiveFiringState,
  partitionDirectivesByLifecycle,
  type Directive,
  type DirectiveFiringState,
} from "../../src/modules/directives/public.js";

const repeatable: Directive = { name: "repeatable", condition: { kind: "always" }, action: "Always steer." };
const once: Directive = {
  name: "once",
  condition: { kind: "always" },
  action: "Steer once.",
  lifecycle: { kind: "once_per_conversation" },
};
const cooldown: Directive = {
  name: "cooldown",
  condition: { kind: "always" },
  action: "Steer on a cooldown.",
  lifecycle: { kind: "cooldown", turns: 2 },
};

const scopeEligible = [repeatable, once, cooldown];

const names = (directives: readonly Directive[]): string[] => directives.map((directive) => directive.name);

describe("partitionDirectivesByLifecycle", () => {
  it("keeps every directive eligible and tracks nothing when there is no firing memory", () => {
    const partition = partitionDirectivesByLifecycle(scopeEligible, undefined);

    expect(names(partition.eligible)).toEqual(["repeatable", "once", "cooldown"]);
    expect([...partition.trackedNames]).toEqual([]);
    expect(partition.suppressed).toEqual([]);
  });

  it("keeps all eligible on a fresh state and tracks the lifecycle-bearing names", () => {
    const partition = partitionDirectivesByLifecycle(scopeEligible, emptyDirectiveFiringState());

    expect(names(partition.eligible)).toEqual(["repeatable", "once", "cooldown"]);
    expect([...partition.trackedNames].sort()).toEqual(["cooldown", "once"]);
    expect(partition.suppressed).toEqual([]);
  });

  it("suppresses a once directive after it has fired and reports it for the trace", () => {
    const afterFiring = commitDirectiveFirings(emptyDirectiveFiringState(), ["once"]);

    const partition = partitionDirectivesByLifecycle(scopeEligible, afterFiring);

    expect(names(partition.eligible)).toEqual(["repeatable", "cooldown"]);
    expect([...partition.trackedNames]).toEqual(["cooldown"]);
    expect(partition.suppressed).toEqual([
      { directiveName: "once", lifecycle: { kind: "once_per_conversation" } },
    ]);
  });

  it("holds a cooldown directive during its window and re-eligibility once it elapses", () => {
    // Fired on turn 0; turns: 2 skips turns 1 and 2, re-eligible strictly after.
    const firedTurn0 = commitDirectiveFirings(emptyDirectiveFiringState(), ["cooldown"]);
    const withinWindow: DirectiveFiringState = firedTurn0; // turnSeq 1

    const suppressedPartition = partitionDirectivesByLifecycle(scopeEligible, withinWindow);
    expect(names(suppressedPartition.eligible)).toEqual(["repeatable", "once"]);
    expect(suppressedPartition.suppressed).toEqual([
      { directiveName: "cooldown", lifecycle: { kind: "cooldown", turns: 2 } },
    ]);

    // Advance turnSeq to 3 without re-firing cooldown: 3 - 0 > 2 → eligible again.
    const elapsed: DirectiveFiringState = {
      ...withinWindow,
      turnSeq: 3,
    };
    const elapsedPartition = partitionDirectivesByLifecycle(scopeEligible, elapsed);
    expect(names(elapsedPartition.eligible)).toEqual(["repeatable", "once", "cooldown"]);
    expect(elapsedPartition.suppressed).toEqual([]);
  });
});
