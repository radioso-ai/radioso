import { describe, expect, it, vi } from "vitest";

import { recordDirectiveSurfaceRendered } from "../../src/modules/chat/services/directives/directiveSurfaceRendering.js";
import type { DirectiveSteeringResult } from "../../src/modules/directives/public.js";

const steering = (overrides: Partial<DirectiveSteeringResult> = {}): DirectiveSteeringResult => ({
  rules: [],
  matches: [],
  omissions: [],
  renderedSurfaces: ["answer"],
  ...overrides,
});

const sessionWith = (result: DirectiveSteeringResult | undefined) => ({
  directiveSteering: result,
  directiveStateStore: { capture: vi.fn() },
});

describe("recordDirectiveSurfaceRendered", () => {
  it("marks the generator as having run, for every matched rule", () => {
    const result = steering();
    const session = sessionWith(result);

    recordDirectiveSurfaceRendered(session as never, "suggested_questions");

    expect(result.renderedSurfaces).toEqual(["answer", "suggested_questions"]);
  });

  it("marks the generator even when no directive carries a lifecycle budget", () => {
    // The gap this closes: a repeatable suggestion-only directive has nothing pending,
    // so lifecycle capture alone would leave the trace unable to say its generator ran.
    const result = steering({ pendingSurfaceFirings: undefined });
    const session = sessionWith(result);

    recordDirectiveSurfaceRendered(session as never, "suggested_questions");

    expect(result.renderedSurfaces).toContain("suggested_questions");
    expect(session.directiveStateStore.capture).not.toHaveBeenCalled();
  });

  it("spends the once/cooldown budget and clears the pending marker", () => {
    const result = steering({
      pendingSurfaceFirings: { suggested_questions: ["no-price-suggestions"] },
    });
    const session = sessionWith(result);

    recordDirectiveSurfaceRendered(session as never, "suggested_questions");

    expect(session.directiveStateStore.capture).toHaveBeenCalledWith(["no-price-suggestions"]);
    expect(result.pendingSurfaceFirings?.suggested_questions).toBeUndefined();
  });

  it("does not double-record a generator that already ran", () => {
    const result = steering({ renderedSurfaces: ["answer", "suggested_questions"] });
    const session = sessionWith(result);

    recordDirectiveSurfaceRendered(session as never, "suggested_questions");

    expect(result.renderedSurfaces).toEqual(["answer", "suggested_questions"]);
  });

  it("is inert on a turn that resolved no steering at all", () => {
    const session = sessionWith(undefined);

    expect(() => recordDirectiveSurfaceRendered(session as never, "suggested_questions")).not.toThrow();
    expect(session.directiveStateStore.capture).not.toHaveBeenCalled();
  });
});

describe("suggestion generator run signal", () => {
  // The complementary case to the streaming lifecycle tests: the generator has not run
  // when its block never entered the prompt, so nothing fires however the turn ends.
  it("leaves the surface unrecorded when the block never rendered", () => {
    const result = steering({
      suggestionBlockRendered: false,
      pendingSurfaceFirings: { suggested_questions: ["follow-up-once"] },
    });
    const session = sessionWith(result);

    // Callers gate on `suggestionBlockRendered`; the recorder is never reached.
    expect(result.suggestionBlockRendered).toBe(false);
    expect(session.directiveStateStore.capture).not.toHaveBeenCalled();
    expect(result.renderedSurfaces).toEqual(["answer"]);
  });
});
