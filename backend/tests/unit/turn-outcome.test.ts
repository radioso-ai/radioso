import { describe, expect, it, vi } from "vitest";

import {
  COMMITTED_REPLAY_CHUNK_CODE_POINTS,
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
  stagedContext: [],
  steering: [],
  trace: {
    traceId: "test-trace",
    startedAt: new Date(0).toISOString(),
    stages: [],
  },
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

  it("delegates to a renderer-owned live stream", async () => {
    const live: TurnOutcomeRenderer = {
      supports: () => true,
      render: vi.fn(),
      async *stream() {
        yield "live ";
        return {
          finalPresentation: {
            answer: "live answer",
            skillName: "order.status",
            skillOutcome: "completed",
            skillStatus: "completed",
          },
          suggestions: { mode: "presentation" },
          hasStreamedAnswer: true,
          streamedAnswer: "live ",
        };
      },
    };
    const stream = new TurnOutcomeRendererRegistry([live]).stream(outcome(), ctx);

    await expect(stream.next()).resolves.toEqual({ value: "live ", done: false });
    await expect(stream.next()).resolves.toMatchObject({
      done: true,
      value: { finalPresentation: { answer: "live answer" } },
    });
    expect(live.render).not.toHaveBeenCalled();
  });

  it("replays a committed presentation in Unicode-safe bounded chunks", async () => {
    const answer = `${"😀".repeat(COMMITTED_REPLAY_CHUNK_CODE_POINTS)}é`;
    const committed = renderer(true, answer);
    const stream = new TurnOutcomeRendererRegistry([committed]).stream(outcome(), ctx);
    const chunks: string[] = [];
    let step = await stream.next();
    while (!step.done) {
      chunks.push(step.value);
      step = await stream.next();
    }

    expect(chunks).toEqual(["😀".repeat(COMMITTED_REPLAY_CHUNK_CODE_POINTS), "é"]);
    expect(chunks.join("")).toBe(answer);
    expect(step.value).toMatchObject({
      finalPresentation: { answer },
      hasStreamedAnswer: true,
      streamedAnswer: answer,
    });
  });
});
