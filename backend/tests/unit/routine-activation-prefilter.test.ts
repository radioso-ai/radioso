import { describe, expect, it, vi } from "vitest";

import { createRoutineActivationPrefilter } from "../../src/app/server/dependencyBuilders.js";

const turn = { sessionId: "session-1", inputEvent: { id: "message-1" } } as never;
const triggers = [
  { routineId: "11111111-1111-4111-8111-111111111111", description: "high" },
  { routineId: "22222222-2222-4222-8222-222222222222", description: "low" },
  { routineId: "33333333-3333-4333-8333-333333333333", description: "preview" },
  { routineId: "44444444-4444-4444-8444-444444444444", description: "mismatch" },
  { routineId: "in-code-routine", description: "in code" },
];

const createPrefilter = (overrides: {
  embedTexts?: ReturnType<typeof vi.fn>;
  search?: ReturnType<typeof vi.fn>;
  selfHeal?: ReturnType<typeof vi.fn>;
} = {}) => {
  const embedTexts = overrides.embedTexts ?? vi.fn().mockResolvedValue([[0.1, 0.2]]);
  const search = overrides.search ?? vi.fn().mockResolvedValue({
    matches: [
      { routineId: "11111111-1111-4111-8111-111111111111", distance: 0.1 },
      { routineId: "22222222-2222-4222-8222-222222222222", distance: 0.9 },
    ],
    noVectorRoutineIds: ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"],
  });
  return {
    embedTexts,
    search,
    prefilter: createRoutineActivationPrefilter({
      accountId: "account-1",
      embeddingService: { embedTexts } as never,
      embeddingModelForWorkspace: vi.fn().mockResolvedValue("text-embedding-3-small"),
      logger: { debug: vi.fn(), warn: vi.fn() } as never,
      routineDefinitionRepository: { searchActivationTriggerEmbeddings: search } as never,
      workspaceId: "workspace-1",
      ...(overrides.selfHeal ? { selfHealTriggerEmbedding: overrides.selfHeal as never } : {}),
    }),
  };
};

describe("routine activation prefilter", () => {
  it("keeps only top vector matches above the floor while preserving no-vector candidates", async () => {
    const { embedTexts, search, prefilter } = createPrefilter();

    const ranked = await prefilter.rank({ query: "I need help", triggers, turn });

    expect(embedTexts).toHaveBeenCalledWith(["I need help"], expect.anything());
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      candidateRoutineIds: triggers.slice(0, 4).map((trigger) => trigger.routineId),
      embeddingModel: "text-embedding-3-small",
      topK: 8,
    }));
    expect(ranked).toEqual([
      { routineId: "11111111-1111-4111-8111-111111111111", score: 0.9 },
      { routineId: "33333333-3333-4333-8333-333333333333", score: 1 },
      { routineId: "44444444-4444-4444-8444-444444444444", score: 1 },
      { routineId: "in-code-routine", score: 1 },
    ]);
  });

  it("fires self-heal only for DB-backed no-vector candidates, with their descriptions", async () => {
    const selfHeal = vi.fn();
    const { prefilter } = createPrefilter({ selfHeal });

    await prefilter.rank({ query: "I need help", triggers, turn });

    expect(selfHeal.mock.calls.map(([call]) => call)).toEqual([
      { routineId: "33333333-3333-4333-8333-333333333333", description: "preview" },
      { routineId: "44444444-4444-4444-8444-444444444444", description: "mismatch" },
    ]);
  });

  it("caps self-heal fan-out per turn", async () => {
    const manyIds = Array.from(
      { length: 20 },
      (_, index) => `${(index + 10).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    const manyTriggers = manyIds.map((routineId, index) => ({ routineId, description: `trigger ${index}` }));
    const search = vi.fn().mockResolvedValue({ matches: [], noVectorRoutineIds: manyIds });
    const selfHeal = vi.fn();
    const { prefilter } = createPrefilter({ search, selfHeal });

    await prefilter.rank({ query: "I need help", triggers: manyTriggers, turn });

    expect(selfHeal).toHaveBeenCalledTimes(16);
  });

  it("returns all candidates if embedding the query fails", async () => {
    const { prefilter } = createPrefilter({ embedTexts: vi.fn().mockRejectedValue(new Error("unavailable")) });

    const ranked = await prefilter.rank({ query: "I need help", triggers, turn });

    expect(ranked).toEqual(triggers.map((trigger) => ({ routineId: trigger.routineId, score: 1 })));
  });
});
