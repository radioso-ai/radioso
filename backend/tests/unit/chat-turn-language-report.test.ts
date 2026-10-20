import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatStreamEvent } from "../../src/modules/chat/contracts/index.js";
import { createTurnLanguageReport, withTurnLanguageReport } from "../../src/modules/chat/services/turnLanguageReport.js";
import { createTurnPlanHandle, lazyPromise, type ChatTurnPlanHandle } from "../../src/modules/chat/services/turnPlanCoordinator.js";
import type { TurnPlan } from "../../src/modules/chat/services/turnPlanService.js";

const plannedHandle = (plan: Partial<TurnPlan>): ChatTurnPlanHandle =>
  createTurnPlanHandle(async () => ({ status: "planned", plan: plan as TurnPlan }) as never);

describe("the turn's language report", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts neither the plan nor the language when the stream merely observes them", async () => {
    const compute = vi.fn(async () => "Italian");
    const report = createTurnLanguageReport();

    void report.observe(lazyPromise(compute), plannedHandle({ responseLanguageTag: "it" }));
    await vi.advanceTimersByTimeAsync(10);

    expect(compute).not.toHaveBeenCalled();
  });

  it("reports the plan's tag as soon as a consumer reads the language, while the turn is still searching", async () => {
    const report = createTurnLanguageReport();
    const plan = plannedHandle({ responseLanguage: "Italian", responseLanguageTag: "it" });
    const language = report.observe(lazyPromise(async () => "Italian"), plan);
    const seen: Array<{ atMs: number; event: ChatStreamEvent }> = [];
    const startedAt = Date.now();
    const turn = (async function* (): AsyncGenerator<ChatStreamEvent> {
      yield { type: "status", stage: "searching" };
      await new Promise((resolve) => setTimeout(resolve, 5));
      await language;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      yield { type: "chunk", text: "Apriamo alle nove." };
    })();

    const collected = (async () => {
      for await (const event of withTurnLanguageReport(turn, report)) {
        seen.push({ atMs: Date.now() - startedAt, event });
      }
    })();
    await vi.runAllTimersAsync();
    await collected;

    expect(seen.map(({ event }) => event.type)).toEqual(["status", "language", "chunk"]);
    expect(seen[1]).toEqual({ atMs: 5, event: { type: "language", tag: "it" } });
  });

  it("reports nothing when the turn never reads its language, and no tag when the language came from elsewhere than the plan's tag", async () => {
    const unread = createTurnLanguageReport();
    void unread.observe(lazyPromise(async () => "Italian"), plannedHandle({ responseLanguageTag: "it" }));
    const detected = createTurnLanguageReport();
    const detectedLanguage = detected.observe(Promise.resolve("Italian"), undefined);
    const untagged = createTurnLanguageReport();
    const untaggedLanguage = untagged.observe(lazyPromise(async () => "Italian"), plannedHandle({ responseLanguage: "Italian" }));

    const eventsOf = async (report: ReturnType<typeof createTurnLanguageReport>, read?: Promise<unknown>) => {
      const events: ChatStreamEvent[] = [];
      const turn = (async function* (): AsyncGenerator<ChatStreamEvent> {
        await read;
        yield { type: "chunk", text: "Ciao." };
      })();
      for await (const event of withTurnLanguageReport(turn, report)) events.push(event);
      return events;
    };

    expect(await eventsOf(unread)).toEqual([{ type: "chunk", text: "Ciao." }]);
    expect(await eventsOf(detected, detectedLanguage)).toEqual([{ type: "language" }, { type: "chunk", text: "Ciao." }]);
    expect(await eventsOf(untagged, untaggedLanguage)).toEqual([{ type: "language" }, { type: "chunk", text: "Ciao." }]);
  });
});
