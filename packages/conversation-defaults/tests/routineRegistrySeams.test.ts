import { describe, expect, it, vi } from "vitest";

import type {
  ClarificationPolicy,
  ConversationModelGateway,
  Routine,
  TurnContext,
} from "@radioso/conversation-contract";
import {
  RoutineRegistry,
  type RankableRoutineCandidates,
  type RankedRoutineMatch,
  type RoutineRegistration,
} from "../src/index.js";

const policy: ClarificationPolicy = { floor: 0.4, margin: 0.15, maxOptions: 4 };

const turn: TurnContext = {
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "input_1", kind: "message", content: "I need to book a call" },
  history: [],
  stagedContext: [],
  steering: [],
};

const routine = (id: string, name?: string): Routine => ({
  id,
  rootStepId: "start",
  steps: [],
  transitions: [],
  ...(name ? { metadata: { name } } : {}),
});

const registration = (
  id: string,
  trigger: Partial<RoutineRegistration["trigger"]> = {},
  name?: string,
): RoutineRegistration => ({
  routine: routine(id, name),
  trigger: { description: `User wants ${id}`, priority: 0, ...trigger },
});

const gateway = (text: string): ConversationModelGateway & { complete: ReturnType<typeof vi.fn> } => ({
  complete: vi.fn(async () => ({ text })),
});

const rankedJson = (matches: unknown): string => JSON.stringify({ matches });

const asRank = (registry: RoutineRegistry, prepared: Awaited<ReturnType<RoutineRegistry["prepareCandidates"]>>): RankableRoutineCandidates => {
  void registry;
  if (prepared.kind !== "rank") {
    throw new Error(`expected rank preparation, got ${prepared.kind}`);
  }
  return prepared;
};

describe("RoutineRegistry seams — prepareCandidates", () => {
  it("partitions a mixed registration set into bounded, planner-consumable summaries", async () => {
    const prefilter = {
      rank: vi.fn(async () => [
        { routineId: "eligible", score: 0.9 },
        { routineId: "below-prefilter", score: 0.1 },
      ]),
      minScore: 0.4,
      topK: 8,
    };
    const registry = new RoutineRegistry([
      registration("gated", { eligible: () => false }),
      registration("suppressed", {}),
      registration("below-prefilter", {}),
      registration("eligible", {}, "Eligible routine"),
    ], { policy, activationPrefilter: prefilter });

    const prepared = await registry.prepareCandidates(turn, { suppressedRoutineIds: ["suppressed"] });

    // gated → eligibility gate; suppressed → completed-state suppression;
    // below-prefilter → min-score bound; only "eligible" survives.
    expect(prefilter.rank).toHaveBeenCalledWith({
      query: "I need to book a call",
      triggers: [
        { routineId: "below-prefilter", description: "User wants below-prefilter" },
        { routineId: "eligible", description: "User wants eligible" },
      ],
      turn,
    });
    expect(prepared.kind).toBe("rank");
    expect(asRank(registry, prepared).candidates).toEqual([
      { routineId: "eligible", title: "Eligible routine", triggerSummary: "User wants eligible", priority: 0 },
    ]);
  });

  it("returns a claim outcome for the first explicit claim without a rank preparation", async () => {
    const registry = new RoutineRegistry([
      registration("disabled", { eligible: () => false, explicitClaim: () => ({ variables: { source: "disabled" } }) }),
      registration("claimed", { explicitClaim: () => ({ variables: { source: "button" } }) }),
    ], { policy });

    const prepared = await registry.prepareCandidates(turn);

    expect(prepared).toEqual({
      kind: "claim",
      activation: { kind: "activate", routineId: "claimed", variables: { source: "button" } },
    });
  });

  it("returns none when no registration is eligible or survives the prefilter", async () => {
    const prefilter = {
      rank: vi.fn(async () => [{ routineId: "demo", score: 0.1 }]),
      minScore: 0.4,
      topK: 4,
    };
    const registry = new RoutineRegistry([registration("demo")], { policy, activationPrefilter: prefilter });

    await expect(registry.prepareCandidates(turn)).resolves.toEqual({ kind: "none" });
  });
});

describe("RoutineRegistry seams — applyRankedDecision parity", () => {
  const parityCase = async (
    registrations: RoutineRegistration[],
    rankings: RankedRoutineMatch[],
  ) => {
    const registry = new RoutineRegistry(registrations, { policy });
    const gw = gateway(rankedJson(rankings));
    const endToEnd = await registry.activator(gw).activate({ turn });
    expect(gw.complete).toHaveBeenCalledTimes(1);

    const prepared = asRank(registry, await registry.prepareCandidates(turn));
    const viaSeams = await registry.applyRankedDecision(prepared, rankings, { turn });
    return { endToEnd, viaSeams };
  };

  it("reproduces an activate decision", async () => {
    const { endToEnd, viaSeams } = await parityCase(
      [registration("demo", {}, "Demo"), registration("support", {}, "Support")],
      [{ routineId: "demo", confidence: 0.9, variables: { company: "Acme" } }, { routineId: "support", confidence: 0.2 }],
    );
    expect(viaSeams).toEqual(endToEnd);
    expect(viaSeams).toMatchObject({ kind: "activate", routineId: "demo", variables: { company: "Acme" } });
  });

  it("reproduces a clarify decision", async () => {
    const { endToEnd, viaSeams } = await parityCase(
      [registration("demo", {}, "Demo"), registration("support", {}, "Support")],
      [{ routineId: "demo", confidence: 0.82 }, { routineId: "support", confidence: 0.79 }],
    );
    expect(viaSeams).toEqual(endToEnd);
    expect(viaSeams).toMatchObject({ kind: "clarify" });
  });

  it("reproduces a below-floor decline", async () => {
    const { endToEnd, viaSeams } = await parityCase(
      [registration("demo")],
      [{ routineId: "demo", confidence: 0.12 }],
    );
    expect(viaSeams).toEqual(endToEnd);
    expect(viaSeams).toBeNull();
  });
});

describe("RoutineRegistry activator — gateway call-count pins", () => {
  it("invokes the gateway exactly once when candidates need ranking", async () => {
    const gw = gateway(rankedJson([{ routineId: "demo", confidence: 0.9 }]));
    await new RoutineRegistry([registration("demo")], { policy }).activator(gw).activate({ turn });
    expect(gw.complete).toHaveBeenCalledTimes(1);
  });

  it("never invokes the gateway for an explicit claim", async () => {
    const gw = gateway(rankedJson([]));
    await new RoutineRegistry([
      registration("claimed", { explicitClaim: () => ({ variables: {} }) }),
    ], { policy }).activator(gw).activate({ turn });
    expect(gw.complete).not.toHaveBeenCalled();
  });

  it("never invokes the gateway when the prefilter excludes every candidate", async () => {
    const gw = gateway(rankedJson([]));
    const prefilter = {
      rank: vi.fn(async () => [{ routineId: "demo", score: 0.1 }]),
      minScore: 0.4,
      topK: 4,
    };
    const result = await new RoutineRegistry([registration("demo")], { policy, activationPrefilter: prefilter })
      .activator(gw)
      .activate({ turn });
    expect(result).toBeNull();
    expect(gw.complete).not.toHaveBeenCalled();
  });
});
