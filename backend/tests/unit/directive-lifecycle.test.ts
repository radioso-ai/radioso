import { describe, expect, it } from "vitest";

import type { Directive, DirectiveMatch } from "../../src/modules/directives/public.js";
import {
  commitDirectiveFirings,
  emptyDirectiveFiringState,
  isDirectiveLifecycleEligible,
  parseDirectiveLifecycle,
  renderedDirectiveNames,
  type DirectiveFiringState,
} from "../../src/modules/directives/directiveLifecycle.js";

const directive = (name: string, lifecycle?: Directive["lifecycle"]): Directive => ({
  name,
  condition: { kind: "always" },
  action: `do ${name}`,
  ...(lifecycle ? { lifecycle } : {}),
});

const match = (name: string): DirectiveMatch => ({
  directive: directive(name),
  selectionMode: "deterministic",
  selectionReason: "test",
});

const stateWith = (turnSeq: number, firings: DirectiveFiringState["firings"]): DirectiveFiringState => ({
  turnSeq,
  firings,
});

describe("parseDirectiveLifecycle", () => {
  it("returns undefined for absent/blank values (defaults to repeatable behavior)", () => {
    expect(parseDirectiveLifecycle(undefined)).toBeUndefined();
    expect(parseDirectiveLifecycle(null)).toBeUndefined();
  });

  it("parses the three known kinds", () => {
    expect(parseDirectiveLifecycle({ kind: "repeatable" })).toEqual({ kind: "repeatable" });
    expect(parseDirectiveLifecycle({ kind: "once_per_conversation" })).toEqual({
      kind: "once_per_conversation",
    });
    expect(parseDirectiveLifecycle({ kind: "cooldown", turns: 3 })).toEqual({
      kind: "cooldown",
      turns: 3,
    });
  });

  it("rejects malformed payloads", () => {
    expect(parseDirectiveLifecycle({ kind: "weekly" })).toBeUndefined();
    expect(parseDirectiveLifecycle({ kind: "cooldown" })).toBeUndefined();
    expect(parseDirectiveLifecycle({ kind: "cooldown", turns: 0 })).toBeUndefined();
    expect(parseDirectiveLifecycle({ kind: "cooldown", turns: -2 })).toBeUndefined();
    expect(parseDirectiveLifecycle("cooldown")).toBeUndefined();
  });
});

describe("isDirectiveLifecycleEligible", () => {
  it("treats an absent lifecycle as repeatable — always eligible", () => {
    const state = stateWith(9, { plain: { lastFiredTurn: 8, count: 4 } });
    expect(isDirectiveLifecycleEligible(directive("plain"), state)).toBe(true);
  });

  it("suppresses once_per_conversation after its first firing", () => {
    const d = directive("intro", { kind: "once_per_conversation" });
    expect(isDirectiveLifecycleEligible(d, emptyDirectiveFiringState())).toBe(true);
    const fired = stateWith(1, { intro: { lastFiredTurn: 0, count: 1 } });
    expect(isDirectiveLifecycleEligible(d, fired)).toBe(false);
  });

  it("suppresses cooldown within the window and re-allows after it passes", () => {
    const d = directive("nudge", { kind: "cooldown", turns: 2 });
    // fired on turn 3; must skip 2 turns → eligible again strictly after turn 5.
    const fired = { nudge: { lastFiredTurn: 3, count: 1 } };
    expect(isDirectiveLifecycleEligible(d, stateWith(4, fired))).toBe(false);
    expect(isDirectiveLifecycleEligible(d, stateWith(5, fired))).toBe(false);
    expect(isDirectiveLifecycleEligible(d, stateWith(6, fired))).toBe(true);
  });

  it("allows cooldown directives that have never fired", () => {
    const d = directive("nudge", { kind: "cooldown", turns: 5 });
    expect(isDirectiveLifecycleEligible(d, emptyDirectiveFiringState())).toBe(true);
  });
});

describe("renderedDirectiveNames", () => {
  it("returns matched directives minus those the bound held back", () => {
    const result = {
      matches: [match("a"), match("b"), match("c")],
      omissions: [],
      bounded: [{ directiveName: "b", reason: "top_k" as const }],
    };
    expect(renderedDirectiveNames(result).sort()).toEqual(["a", "c"]);
  });

  it("returns all matches when nothing was bounded", () => {
    const result = { matches: [match("a"), match("b")], omissions: [] };
    expect(renderedDirectiveNames(result).sort()).toEqual(["a", "b"]);
  });
});

describe("commitDirectiveFirings", () => {
  it("stamps fired directives with the current turn and advances the sequence", () => {
    const before = stateWith(2, { old: { lastFiredTurn: 1, count: 1 } });
    const after = commitDirectiveFirings(before, ["intro", "old"]);
    expect(after.turnSeq).toBe(3);
    expect(after.firings.intro).toEqual({ lastFiredTurn: 2, count: 1 });
    expect(after.firings.old).toEqual({ lastFiredTurn: 2, count: 2 });
  });

  it("advances the sequence even when nothing fired", () => {
    const before = emptyDirectiveFiringState();
    const after = commitDirectiveFirings(before, []);
    expect(after.turnSeq).toBe(1);
    expect(after.firings).toEqual({});
  });

  it("does not mutate the input state", () => {
    const before = stateWith(0, {});
    commitDirectiveFirings(before, ["x"]);
    expect(before).toEqual(stateWith(0, {}));
  });
});
