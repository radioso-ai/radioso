import { describe, expect, it, vi } from "vitest";

import { createRoutineActivationPrefilter } from "../../src/modules/routines/public.js";

const turn = { sessionId: "session-1", inputEvent: { id: "message-1" } } as never;
const triggers = [
  { routineId: "11111111-1111-4111-8111-111111111111", description: "high" },
  { routineId: "22222222-2222-4222-8222-222222222222", description: "low" },
  { routineId: "33333333-3333-4333-8333-333333333333", description: "preview" },
  { routineId: "44444444-4444-4444-8444-444444444444", description: "mismatch" },
  { routineId: "in-code-routine", description: "in code" },
];

// Default fly vectors against query [1, 0]: preview → cos 1, mismatch → cos 0
// (floored out of the ranked result, but still self-healable), in-code → cos 0.6.
const defaultEmbedTexts = () =>
  vi
    .fn()
    .mockResolvedValueOnce([[1, 0]])
    .mockResolvedValueOnce([[1, 0], [0, 1], [0.6, 0.8]]);

const createPrefilter = (overrides: {
  embedTexts?: ReturnType<typeof vi.fn>;
  search?: ReturnType<typeof vi.fn>;
  selfHeal?: ReturnType<typeof vi.fn>;
} = {}) => {
  const embedTexts = overrides.embedTexts ?? defaultEmbedTexts();
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
      clusteringEmbeddings: {
        async embedForClustering(request: {
          texts: readonly string[];
          usageContext?: unknown;
        }) {
          return {
            vectors: await (embedTexts as unknown as (
              texts: string[],
              options?: { usageContext?: unknown },
            ) => Promise<number[][]>)(
              [...request.texts],
              { usageContext: request.usageContext },
            ),
          };
        },
      },
      embeddingModelForWorkspace: vi.fn().mockResolvedValue("text-embedding-3-small"),
      logger: { debug: vi.fn(), warn: vi.fn() } as never,
      routineDefinitionRepository: { searchActivationTriggerEmbeddings: search } as never,
      workspaceId: "workspace-1",
      ...(overrides.selfHeal ? { selfHealTriggerEmbedding: overrides.selfHeal as never } : {}),
    }),
  };
};

describe("routine activation prefilter", () => {
  it("merges persisted top-k scores with fly-embedded scores for unscored candidates", async () => {
    const { embedTexts, search, prefilter } = createPrefilter();

    const ranked = await prefilter.rank({ query: "I need help", triggers, turn });

    expect(embedTexts).toHaveBeenNthCalledWith(1, ["I need help"], expect.anything());
    expect(embedTexts).toHaveBeenNthCalledWith(2, ["preview", "mismatch", "in code"], expect.anything());
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      candidateRoutineIds: triggers.slice(0, 4).map((trigger) => trigger.routineId),
      embeddingModel: "text-embedding-3-small",
      topK: 8,
    }));
    // 222 (similarity 0.1) and 444 (fly cosine 0) fall below the 0.2 floor; no
    // candidate is ever ranked above a real similarity score.
    expect(ranked).toEqual([
      { routineId: "11111111-1111-4111-8111-111111111111", score: 0.9 },
      { routineId: "33333333-3333-4333-8333-333333333333", score: 1 },
      { routineId: "in-code-routine", score: 0.6 },
    ]);
  });

  it("fires self-heal with the fly-computed vector for DB-backed candidates only, floor-dropped included", async () => {
    const selfHeal = vi.fn();
    const { prefilter } = createPrefilter({ selfHeal });

    await prefilter.rank({ query: "I need help", triggers, turn });

    expect(selfHeal.mock.calls.map(([call]) => call)).toEqual([
      {
        routineId: "33333333-3333-4333-8333-333333333333",
        description: "preview",
        embedding: [1, 0],
        model: "text-embedding-3-small",
      },
      {
        routineId: "44444444-4444-4444-8444-444444444444",
        description: "mismatch",
        embedding: [0, 1],
        model: "text-embedding-3-small",
      },
    ]);
  });

  it("caps self-heal fan-out per turn", async () => {
    const manyIds = Array.from(
      { length: 20 },
      (_, index) => `${(index + 10).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    const manyTriggers = manyIds.map((routineId, index) => ({ routineId, description: `trigger ${index}` }));
    const search = vi.fn().mockResolvedValue({ matches: [], noVectorRoutineIds: manyIds });
    const embedTexts = vi
      .fn()
      .mockResolvedValueOnce([[1, 0]])
      .mockResolvedValueOnce(manyIds.map(() => [1, 0]));
    const selfHeal = vi.fn();
    const { prefilter } = createPrefilter({ embedTexts, search, selfHeal });

    await prefilter.rank({ query: "I need help", triggers: manyTriggers, turn });

    expect(selfHeal).toHaveBeenCalledTimes(16);
  });

  it("scores every candidate on the fly when the persisted search fails", async () => {
    const search = vi.fn().mockRejectedValue(new Error("relation missing"));
    const embedTexts = vi
      .fn()
      .mockResolvedValueOnce([[1, 0]])
      .mockResolvedValueOnce([[1, 0], [0.6, 0.8], [1, 0], [0, 1], [0.6, 0.8]]);
    const { prefilter } = createPrefilter({ embedTexts, search });

    const ranked = await prefilter.rank({ query: "I need help", triggers, turn });

    expect(embedTexts).toHaveBeenNthCalledWith(2, triggers.map((trigger) => trigger.description), expect.anything());
    expect(ranked).toEqual([
      { routineId: "11111111-1111-4111-8111-111111111111", score: 1 },
      { routineId: "22222222-2222-4222-8222-222222222222", score: 0.6 },
      { routineId: "33333333-3333-4333-8333-333333333333", score: 1 },
      { routineId: "in-code-routine", score: 0.6 },
    ]);
  });

  it("keeps unscorable candidates at the floor when only the fly embedding fails", async () => {
    const embedTexts = vi
      .fn()
      .mockResolvedValueOnce([[1, 0]])
      .mockRejectedValueOnce(new Error("batch unavailable"));
    const { prefilter } = createPrefilter({ embedTexts });

    const ranked = await prefilter.rank({ query: "I need help", triggers, turn });

    // Persisted scores are kept; unknowns survive at exactly the floor so they
    // can reach ranking without ever outranking a scored match.
    expect(ranked).toEqual([
      { routineId: "11111111-1111-4111-8111-111111111111", score: 0.9 },
      { routineId: "33333333-3333-4333-8333-333333333333", score: 0.2 },
      { routineId: "44444444-4444-4444-8444-444444444444", score: 0.2 },
      { routineId: "in-code-routine", score: 0.2 },
    ]);
  });

  it("rethrows when the query cannot be embedded so the registry falls back to the unpruned candidate set", async () => {
    const { prefilter } = createPrefilter({ embedTexts: vi.fn().mockRejectedValue(new Error("unavailable")) });

    await expect(prefilter.rank({ query: "I need help", triggers, turn })).rejects.toThrow("unavailable");
  });

  it("rethrows when both the persisted search and the fly embedding fail", async () => {
    const search = vi.fn().mockRejectedValue(new Error("relation missing"));
    const embedTexts = vi
      .fn()
      .mockResolvedValueOnce([[1, 0]])
      .mockRejectedValueOnce(new Error("batch unavailable"));
    const { prefilter } = createPrefilter({ embedTexts, search });

    await expect(prefilter.rank({ query: "I need help", triggers, turn })).rejects.toThrow("batch unavailable");
  });
});
