import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  ClarificationPolicy,
  Routine,
  TurnContext,
} from "@radioso/conversation-contract";
import { RoutineRegistry, type RoutineRegistration } from "../src/index.js";

const policy: ClarificationPolicy = {
  floor: 0.4,
  margin: 0.15,
  maxOptions: 4,
};

const turn: TurnContext = {
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "input_1", kind: "message", content: "I need to book a call" },
  history: [],
  stagedContext: [],
  steering: [],
};

const routine = (id: string): Routine => ({
  id,
  rootStepId: "start",
  steps: [],
  transitions: [],
});

const registration = (
  id: string,
  trigger: Partial<RoutineRegistration["trigger"]> = {},
): RoutineRegistration => ({
  routine: routine(id),
  trigger: {
    description: `User wants ${id}`,
    priority: 0,
    ...trigger,
  },
});

const gateway = (text: string): ConversationModelGateway => ({
  complete: vi.fn(async () => ({ text })),
});

const rankedJson = (matches: unknown): string => JSON.stringify({ matches });

describe("RoutineRegistry ranked activation", () => {
  it("sends every eligible trigger in one gateway call regardless of registration count", async () => {
    const registrations = Array.from({ length: 10 }, (_, index) => registration(`routine_${index}`));
    const gw = gateway(rankedJson([
      { routineId: "routine_7", confidence: 0.9, variables: { requestedSlot: "morning" } },
      { routineId: "routine_2", confidence: 0.2 },
    ]));

    const result = await new RoutineRegistry(registrations, { policy }).activator(gw).activate({ turn });

    expect(gw.complete).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gw.complete).mock.calls[0]![0].systemPrompt).toContain("routine_0");
    expect(vi.mocked(gw.complete).mock.calls[0]![0].systemPrompt).toContain("routine_9");
    expect(result).toMatchObject({
      kind: "activate",
      routineId: "routine_7",
      variables: { requestedSlot: "morning" },
    });
    expect(result?.kind === "activate" ? result.decisionMetadata : null).toMatchObject({
      decision: { kind: "auto_pick", reason: "clear_margin" },
      consideredCandidates: [
        { id: "routine_7", confidence: 0.9 },
        { id: "routine_2", confidence: 0.2 },
      ],
    });
  });

  it("parses structured ranked output into clarification candidates with activation variables as opaque payload", async () => {
    const gw = gateway(rankedJson([
      { routineId: "demo", confidence: 0.82, variables: { company: "Acme" } },
      { routineId: "support", confidence: 0.79, variables: { topic: "billing" } },
    ]));

    const result = await new RoutineRegistry([
      registration("demo", { description: "User wants to book a product demo" }),
      registration("support", { description: "User wants to book a support call" }),
    ], { policy }).activator(gw).activate({ turn });

    expect(result).toEqual({
      kind: "clarify",
      candidates: [
        expect.objectContaining({
          id: "demo",
          label: "demo",
          description: "User wants to book a product demo",
          confidence: 0.82,
          payload: { routineId: "demo", variables: { company: "Acme" } },
        }),
        expect.objectContaining({
          id: "support",
          label: "support",
          description: "User wants to book a support call",
          confidence: 0.79,
          payload: { routineId: "support", variables: { topic: "billing" } },
        }),
      ],
    });
  });

  it("delegates floor, margin, and priority decision order to clarification policy semantics", async () => {
    const gw = gateway(rankedJson([
      { routineId: "lower-confidence-priority", confidence: 0.78 },
      { routineId: "higher-confidence", confidence: 0.81 },
      { routineId: "weak", confidence: 0.39 },
    ]));

    const result = await new RoutineRegistry([
      registration("higher-confidence", { priority: 1 }),
      registration("lower-confidence-priority", { priority: 10 }),
      registration("weak", { priority: 100 }),
    ], { policy }).activator(gw).activate({ turn });

    expect(result).toMatchObject({
      kind: "activate",
      routineId: "lower-confidence-priority",
      variables: undefined,
    });
  });

  it("uses deterministic confidence, priority, then id ordering for ask candidates", async () => {
    const gw = gateway(rankedJson([
      { routineId: "zeta", confidence: 0.8 },
      { routineId: "alpha", confidence: 0.8 },
      { routineId: "beta", confidence: 0.8 },
    ]));

    const result = await new RoutineRegistry([
      registration("zeta", { priority: 1 }),
      registration("alpha", { priority: 2 }),
      registration("beta", { priority: 2 }),
    ], { policy }).activator(gw).activate({ turn });

    expect(result).toMatchObject({
      kind: "clarify",
      candidates: [
        { id: "alpha" },
        { id: "beta" },
        { id: "zeta" },
      ],
    });
  });

  it("returns null without throwing when the model output is malformed", async () => {
    const gw = gateway("not json");

    await expect(new RoutineRegistry([
      registration("demo"),
      registration("support"),
    ], { policy }).activator(gw).activate({ turn })).resolves.toBeNull();
  });

  it("filters ineligible routines before prompting and candidate construction", async () => {
    const gw = gateway(rankedJson([
      { routineId: "enabled", confidence: 0.82 },
    ]));

    const result = await new RoutineRegistry([
      registration("disabled", {
        description: "Disabled routine must not be ranked",
        eligible: () => false,
      }),
      registration("enabled", {
        description: "Enabled routine can be ranked",
        eligible: () => true,
      }),
    ], { policy }).activator(gw).activate({ turn });

    expect(gw.complete).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(gw.complete).mock.calls[0]![0].systemPrompt;
    expect(prompt).toContain("enabled");
    expect(prompt).not.toContain("disabled");
    expect(prompt).not.toContain("Disabled routine must not be ranked");
    expect(result).toMatchObject({ kind: "activate", routineId: "enabled", variables: undefined });
  });

  it("activates the first eligible explicit claim without a gateway call", async () => {
    const gw = gateway(rankedJson([]));

    const result = await new RoutineRegistry([
      registration("disabled", {
        eligible: () => false,
        explicitClaim: () => ({ variables: { source: "disabled" } }),
      }),
      registration("claimed", {
        explicitClaim: () => ({ variables: { source: "button" } }),
      }),
      registration("later", {
        explicitClaim: () => ({ variables: { source: "later" } }),
      }),
    ], { policy }).activator(gw).activate({ turn });

    expect(gw.complete).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "activate",
      routineId: "claimed",
      variables: { source: "button" },
    });
  });
});
