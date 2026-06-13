import { describe, expect, it, vi } from "vitest";

import type {
  ClarificationCandidate,
  ClarificationPolicy,
  ConversationClarificationStore,
  PendingClarification,
  RecentClarificationReader,
  TurnContext,
} from "@radioso/conversation-contract";
import {
  clarificationStage,
  decideClarification,
  resolvePendingClarification,
} from "../src/clarification.js";

const policy: ClarificationPolicy = {
  floor: 0.4,
  margin: 0.15,
  maxOptions: 4,
};

const candidate = (overrides: Partial<ClarificationCandidate> & Pick<ClarificationCandidate, "id" | "confidence">): ClarificationCandidate => ({
  label: `Option ${overrides.id}`,
  payload: { opaque: overrides.id },
  ...overrides,
});

const turn = (content = "choose alpha"): TurnContext => ({
  agent: { id: "agent_1", name: "Support" },
  sessionId: "session_1",
  inputEvent: { id: "msg_1", kind: "message", content },
  history: [],
  stagedContext: [],
  steering: [],
});

const pending = (overrides: Partial<PendingClarification> = {}): PendingClarification => ({
  sessionId: "session_1",
  source: "test_surface",
  originalQuery: "How do I upload a document via the REST API? Give me a curl example.",
  mode: "ask",
  candidates: [
    candidate({ id: "alpha", label: "Alpha", confidence: 0.82, payload: { opaque: "alpha" } }),
    candidate({ id: "beta", label: "Beta", confidence: 0.79, payload: { opaque: "beta" } }),
  ],
  askedEventId: "assistant_1",
  status: "pending",
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  ...overrides,
});

const storeWith = (pendingState: PendingClarification | null): ConversationClarificationStore & {
  loadPending: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} => ({
  loadPending: vi.fn(async () => pendingState),
  save: vi.fn(),
  clear: vi.fn(async () => {}),
});

describe("decideClarification", () => {
  it("filters candidates below the confidence floor and returns none when none remain", () => {
    expect(decideClarification([
      candidate({ id: "a", confidence: 0.39 }),
      candidate({ id: "b", confidence: 0.1 }),
    ], policy)).toEqual({ kind: "none" });
  });

  it("auto-picks a clear margin winner", () => {
    const winner = candidate({ id: "winner", confidence: 0.91 });
    const decision = decideClarification([
      candidate({ id: "runner", confidence: 0.7 }),
      winner,
    ], policy);

    expect(decision).toEqual({ kind: "auto_pick", candidate: winner, reason: "clear_margin" });
  });

  it("asks when the top candidates are too close", () => {
    const decision = decideClarification([
      candidate({ id: "a", confidence: 0.81 }),
      candidate({ id: "b", confidence: 0.76 }),
    ], policy);

    expect(decision.kind).toBe("ask");
    expect(decision.kind === "ask" ? decision.candidates.map((item) => item.id) : []).toEqual(["a", "b"]);
  });

  it("caps ask options at maxOptions after deterministic ordering", () => {
    const decision = decideClarification([
      candidate({ id: "a", confidence: 0.8 }),
      candidate({ id: "b", confidence: 0.79 }),
      candidate({ id: "c", confidence: 0.78 }),
      candidate({ id: "d", confidence: 0.77 }),
      candidate({ id: "e", confidence: 0.76 }),
    ], { ...policy, maxOptions: 3 });

    expect(decision.kind).toBe("ask");
    expect(decision.kind === "ask" ? decision.candidates.map((item) => item.id) : []).toEqual(["a", "b", "c"]);
  });

  it("orders by confidence descending, then priority descending, then id", () => {
    // Top priority (3) is shared by b and c, so priority arbitration does not
    // fire and the ask presents the deterministic ordering.
    const decision = decideClarification([
      candidate({ id: "z", confidence: 0.7 }),
      candidate({ id: "b", confidence: 0.8 }),
      candidate({ id: "a", confidence: 0.8 }),
      candidate({ id: "c", confidence: 0.8 }),
    ], { ...policy, margin: 1 }, { priorities: { z: 1, b: 3, a: 2, c: 3 } });

    expect(decision.kind).toBe("ask");
    expect(decision.kind === "ask" ? decision.candidates.map((item) => item.id) : []).toEqual(["b", "c", "a", "z"]);
  });

  it("auto-picks the unique highest authored priority in the too-close set, even when not the confidence leader", () => {
    const decision = decideClarification([
      candidate({ id: "leader", confidence: 0.81 }),
      candidate({ id: "prioritized", confidence: 0.79 }),
    ], policy, { priorities: { leader: 1, prioritized: 5 } });

    expect(decision).toMatchObject({
      kind: "auto_pick",
      reason: "priority",
      candidate: { id: "prioritized" },
    });
  });

  it("asks only among the too-close set, excluding above-floor candidates beyond the margin", () => {
    const decision = decideClarification([
      candidate({ id: "a", confidence: 0.8 }),
      candidate({ id: "b", confidence: 0.78 }),
      candidate({ id: "c", confidence: 0.45 }),
    ], policy);

    expect(decision.kind).toBe("ask");
    expect(decision.kind === "ask" ? decision.candidates.map((item) => item.id) : []).toEqual(["a", "b"]);
  });

  it("auto-picks the strongest candidate in suppressed mode", () => {
    const decision = decideClarification([
      candidate({ id: "a", confidence: 0.81 }),
      candidate({ id: "b", confidence: 0.8 }),
    ], policy, { suppressAsk: true });

    expect(decision).toMatchObject({ kind: "auto_pick", reason: "suppressed", candidate: { id: "a" } });
  });

  it("auto-picks on loop-guard suppression when the same candidate set was just asked", () => {
    const decision = decideClarification([
      candidate({ id: "b", confidence: 0.8 }),
      candidate({ id: "a", confidence: 0.79 }),
    ], policy, { loopGuardCandidateIds: ["a", "b"] });

    expect(decision).toMatchObject({ kind: "auto_pick", reason: "loop_guard", candidate: { id: "b" } });
  });

  it("returns none for uniformly weak candidate sets", () => {
    expect(decideClarification([
      candidate({ id: "a", confidence: 0.1 }),
      candidate({ id: "b", confidence: 0.2 }),
    ], policy)).toEqual({ kind: "none" });
  });
});

describe("clarificationStage", () => {
  it("builds a metadata-safe stage without candidate payloads", () => {
    const stage = clarificationStage({
      surface: "test_surface",
      decision: {
        kind: "ask",
        candidates: [
          candidate({ id: "a", label: "Alpha", confidence: 0.8, payload: { secret: "payload" } }),
          candidate({ id: "b", label: "Beta", confidence: 0.78, payload: { secret: "payload" } }),
        ],
      },
      reason: "too_close",
      margin: 0.02,
      mappingOutcome: "mapped:a",
    });

    expect(stage.kind).toBe("clarification");
    expect(stage.outputs).toEqual({
      surface: "test_surface",
      decision: "asked",
      reason: "too_close",
      margin: 0.02,
      candidates: [
        { id: "a", label: "Alpha", confidence: 0.8 },
        { id: "b", label: "Beta", confidence: 0.78 },
      ],
      mappingOutcome: "mapped:a",
    });
    expect(JSON.stringify(stage)).not.toContain("secret");
  });

  it("records all considered candidates and the chosen id for auto-picks", () => {
    const stage = clarificationStage({
      surface: "routine_activation",
      decision: {
        kind: "auto_pick",
        candidate: candidate({ id: "demo", label: "Demo call", confidence: 0.82, payload: { secret: "payload" } }),
        reason: "priority",
      },
      consideredCandidates: [
        candidate({ id: "support", label: "Support call", confidence: 0.83, payload: { secret: "payload" } }),
        candidate({ id: "demo", label: "Demo call", confidence: 0.82, payload: { secret: "payload" } }),
      ],
      margin: 0.01,
    });

    expect(stage.outputs).toEqual({
      surface: "routine_activation",
      decision: "auto_picked",
      reason: "priority",
      margin: 0.01,
      chosenCandidateId: "demo",
      candidates: [
        { id: "support", label: "Support call", confidence: 0.83 },
        { id: "demo", label: "Demo call", confidence: 0.82 },
      ],
    });
    expect(JSON.stringify(stage)).not.toContain("secret");
  });
});

describe("resolvePendingClarification", () => {
  it("maps a reply, clears as resolved, and returns the chosen opaque candidate with its source", async () => {
    const current = pending();
    const store = storeWith(current);
    const clarifier = {
      phraseQuestion: vi.fn(),
      mapReply: vi.fn(async () => ({ kind: "chosen" as const, id: "alpha" })),
    };

    const resolved = await resolvePendingClarification({
      store,
      clarifier,
      turn: turn("alpha"),
    });

    expect(clarifier.mapReply).toHaveBeenCalledWith({ candidates: current.candidates, turn: expect.objectContaining({ sessionId: "session_1" }) });
    expect(store.clear).toHaveBeenCalledWith({ sessionId: "session_1", outcome: "resolved" });
    expect(resolved).toEqual({
      resolvedPending: true,
      suppressNewClarification: true,
      outcome: "resolved",
      chosen: {
        source: "test_surface",
        candidate: current.candidates[0],
        originalQuery: "How do I upload a document via the REST API? Give me a curl example.",
      },
    });
  });

  it("clears declined and unrelated replies without exposing a chosen candidate", async () => {
    const store = storeWith(pending());

    const resolved = await resolvePendingClarification({
      store,
      clarifier: {
        phraseQuestion: vi.fn(),
        mapReply: vi.fn(async () => ({ kind: "unrelated" as const })),
      },
      turn: turn("what is pricing?"),
    });

    expect(store.clear).toHaveBeenCalledWith({ sessionId: "session_1", outcome: "declined" });
    expect(resolved).toEqual({
      resolvedPending: true,
      suppressNewClarification: true,
      outcome: "declined",
    });
  });

  it("expires stale pending clarification without calling the mapper", async () => {
    const store = storeWith(pending({ expiresAt: new Date("2020-01-01T00:00:00.000Z") }));
    const clarifier = {
      phraseQuestion: vi.fn(),
      mapReply: vi.fn(),
    };

    const resolved = await resolvePendingClarification({ store, clarifier, turn: turn() });

    expect(clarifier.mapReply).not.toHaveBeenCalled();
    expect(store.clear).toHaveBeenCalledWith({ sessionId: "session_1", outcome: "expired" });
    expect(resolved).toEqual({
      resolvedPending: true,
      suppressNewClarification: true,
      outcome: "expired",
    });
  });

  it("returns recently completed candidate ids for loop guard when no pending row exists", async () => {
    const recentReader: RecentClarificationReader = {
      loadRecent: vi.fn(async () => pending({ status: "declined" })),
    };

    const resolved = await resolvePendingClarification({
      store: storeWith(null),
      recentReader,
      clarifier: {
        phraseQuestion: vi.fn(),
        mapReply: vi.fn(),
      },
      turn: turn(),
    });

    expect(resolved).toEqual({
      resolvedPending: false,
      loopGuardCandidateIds: ["alpha", "beta"],
    });
  });

  it("does not expose the stored original query in clarification trace outputs", () => {
    const originalQuery = "How do I upload a document via the REST API? Give me a curl example.";
    const stage = clarificationStage({
      surface: "retrieval_sense",
      decision: {
        kind: "ask",
        candidates: pending({ originalQuery }).candidates,
      },
      mappingOutcome: "mapped:alpha",
    });

    expect(JSON.stringify(stage.outputs)).not.toContain(originalQuery);
  });
});
