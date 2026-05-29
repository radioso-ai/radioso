import { describe, expect, it, vi } from "vitest";

import {
  GenericTurnOutcomeRenderer,
  TurnOutcomeRendererRegistry,
  type TurnOutcome,
  type TurnOutcomeRenderer,
  type TurnRenderContext,
} from "../../src/modules/chat/services/turnOutcome.js";
import type { SkillOutcome } from "../../src/modules/skills/public.js";

const outcome = (over: Partial<SkillOutcome> = {}): TurnOutcome => ({
  kind: "generic",
  skillName: "order.status",
  outcome: { status: "completed", answer: "Your order ships tomorrow.", ...over },
  steering: [],
});

const ctx = {} as TurnRenderContext;

describe("GenericTurnOutcomeRenderer", () => {
  it("renders a settled skill outcome's answer into a presentation", async () => {
    const presentation = await new GenericTurnOutcomeRenderer().render(outcome(), ctx);
    expect(presentation).toMatchObject({
      answer: "Your order ships tomorrow.",
      skillName: "order.status",
      skillOutcome: "completed",
      skillStatus: "completed",
    });
  });

  it("renders an empty answer when the outcome carries none (no hard-coded copy)", async () => {
    const presentation = await new GenericTurnOutcomeRenderer().render(outcome({ answer: undefined }), ctx);
    expect(presentation.answer).toBe("");
  });

  it("supports any outcome (it is the fallback renderer)", () => {
    expect(new GenericTurnOutcomeRenderer().supports()).toBe(true);
  });
});

describe("TurnOutcomeRendererRegistry", () => {
  const renderer = (supports: boolean, answer: string): TurnOutcomeRenderer => ({
    supports: () => supports,
    render: vi.fn().mockResolvedValue({ answer, skillName: "x", skillOutcome: "completed", skillStatus: "completed" }),
  });

  it("resolves to the first renderer that supports the outcome", () => {
    const first = renderer(false, "skip");
    const second = renderer(true, "use");
    const third = renderer(true, "later");
    const registry = new TurnOutcomeRendererRegistry([first, second, third]);
    expect(registry.resolve(outcome())).toBe(second);
  });

  it("throws when no renderer supports the outcome", () => {
    const registry = new TurnOutcomeRendererRegistry([renderer(false, "skip")]);
    expect(() => registry.resolve(outcome())).toThrow(/no turn-outcome renderer/i);
  });
});
