import { describe, expect, it, vi } from "vitest";

import type {
  ClarificationCandidate,
  ConversationClarificationStore,
  ConversationRoutineActivator,
  PendingClarification,
  RecentClarificationReader,
  TurnContext,
} from "@radioso/conversation-contract";

import { resolvePendingClarification } from "../../src/modules/chat/services/clarification/pendingClarificationResolver.js";

const candidates: ClarificationCandidate[] = [
  {
    id: "demo",
    label: "Demo call",
    description: "Book a product demo",
    confidence: 0.82,
    payload: { routineId: "demo", variables: { company: "Acme" } },
  },
  {
    id: "support",
    label: "Support call",
    description: "Talk to support",
    confidence: 0.79,
    payload: { routineId: "support", variables: { topic: "billing" } },
  },
];

const turn = (content = "the demo one"): TurnContext => ({
  agent: { id: "agent_1", name: "Support" },
  sessionId: "conv_1",
  inputEvent: { id: "msg_1", kind: "message", content, locale: "es" },
  history: [],
  stagedContext: [],
  steering: [],
});

const pending = (overrides: Partial<PendingClarification> = {}): PendingClarification => ({
  sessionId: "conv_1",
  source: "routine_activation",
  candidates,
  askedEventId: "assistant_1",
  status: "pending",
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  ...overrides,
});

const retrievalSensePending = (): PendingClarification => pending({
  source: "retrieval_sense",
  originalQuery: "How do I upload a document via the REST API? Give me a curl example.",
  mode: "ask",
  candidates: [
    {
      id: "doc-hatha",
      label: "Hatha yoga",
      confidence: 0.6,
      payload: { documentIds: ["doc-hatha", "doc-hatha-es"] },
    },
    {
      id: "doc-raja",
      label: "Raja yoga",
      confidence: 0.58,
      payload: { documentIds: ["doc-raja"] },
    },
  ],
});

const storeWith = (pendingState: PendingClarification | null): ConversationClarificationStore & {
  loadPending: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} => ({
  loadPending: vi.fn(async () => pendingState),
  save: vi.fn(),
  clear: vi.fn(async () => {}),
});

describe("resolvePendingClarification", () => {
  it("maps a non-English reply to a chosen routine and returns a forced activator without another activation model call", async () => {
    const store = storeWith(pending());
    const clarifier = {
      phraseQuestion: vi.fn(),
      mapReply: vi.fn(async () => ({ kind: "chosen" as const, id: "demo" })),
    };
    const activationGateway: ConversationRoutineActivator = {
      activate: vi.fn(async () => {
        throw new Error("activation model should not be called");
      }),
    };

    const resolved = await resolvePendingClarification({
      store,
      clarifier,
      turn: turn("la demo"),
    });

    expect(clarifier.mapReply).toHaveBeenCalledWith({ candidates, turn: expect.objectContaining({ inputEvent: expect.objectContaining({ locale: "es" }) }) });
    expect(store.clear).toHaveBeenCalledWith({ sessionId: "conv_1", outcome: "resolved" });
    expect(resolved).toMatchObject({ kind: "routine_activation", resolvedPending: true });
    await expect(resolved.kind === "routine_activation" ? resolved.activator.activate({ turn: turn() }) : activationGateway.activate({ turn: turn() }))
      .resolves.toEqual({ kind: "activate", routineId: "demo", variables: { company: "Acme" } });
    expect(activationGateway.activate).not.toHaveBeenCalled();
  });

  it("clears declined pending clarification and proceeds normally", async () => {
    const store = storeWith(pending());
    const resolved = await resolvePendingClarification({
      store,
      clarifier: {
        phraseQuestion: vi.fn(),
        mapReply: vi.fn(async () => ({ kind: "declined" as const })),
      },
      turn: turn("none of those"),
    });

    expect(store.clear).toHaveBeenCalledWith({ sessionId: "conv_1", outcome: "declined" });
    expect(resolved).toEqual({ kind: "normal", resolvedPending: true, suppressNewClarification: true, outcome: "declined" });
  });

  it("clears unrelated pending clarification and proceeds normally", async () => {
    const store = storeWith(pending());
    const resolved = await resolvePendingClarification({
      store,
      clarifier: {
        phraseQuestion: vi.fn(),
        mapReply: vi.fn(async () => ({ kind: "unrelated" as const })),
      },
      turn: turn("how much does it cost?"),
    });

    expect(store.clear).toHaveBeenCalledWith({ sessionId: "conv_1", outcome: "declined" });
    expect(resolved).toEqual({ kind: "normal", resolvedPending: true, suppressNewClarification: true, outcome: "declined" });
  });

  it("expires stale pending clarification and proceeds normally", async () => {
    const store = storeWith(pending({ expiresAt: new Date("2020-01-01T00:00:00.000Z") }));
    const resolved = await resolvePendingClarification({
      store,
      clarifier: {
        phraseQuestion: vi.fn(),
        mapReply: vi.fn(),
      },
      turn: turn(),
    });

    expect(store.clear).toHaveBeenCalledWith({ sessionId: "conv_1", outcome: "expired" });
    expect(resolved).toEqual({ kind: "normal", resolvedPending: true, suppressNewClarification: true, outcome: "expired" });
  });

  it("returns the recently declined candidate ids for loop guard when there is no pending row", async () => {
    const store = storeWith(null);
    const recentReader: RecentClarificationReader = {
      loadRecent: vi.fn(async () => pending({ status: "declined" })),
    };

    const resolved = await resolvePendingClarification({
      store,
      recentReader,
      clarifier: {
        phraseQuestion: vi.fn(),
        mapReply: vi.fn(),
      },
      turn: turn(),
    });

    expect(resolved).toEqual({
      kind: "normal",
      resolvedPending: false,
      loopGuardCandidateIds: ["demo", "support"],
    });
  });

  it("marks resolve-then-new-ask as impossible for the same turn", async () => {
    const store = storeWith(pending());
    const resolved = await resolvePendingClarification({
      store,
      clarifier: {
        phraseQuestion: vi.fn(),
        mapReply: vi.fn(async () => ({ kind: "unrelated" as const })),
      },
      turn: turn(),
    });

    expect(resolved.resolvedPending).toBe(true);
    expect(resolved.suppressNewClarification).toBe(true);
  });

  it("lets ignored offer-mode clarification clear without suppressing a normal new turn", async () => {
    const store = storeWith(pending({ mode: "offer" }));
    const resolved = await resolvePendingClarification({
      store,
      clarifier: {
        phraseQuestion: vi.fn(),
        mapReply: vi.fn(async () => ({ kind: "unrelated" as const })),
      },
      turn: turn("how much does it cost?"),
    });

    expect(store.clear).toHaveBeenCalledWith({ sessionId: "conv_1", outcome: "declined" });
    expect(resolved).toEqual({
      kind: "normal",
      resolvedPending: true,
      suppressNewClarification: undefined,
      loopGuardCandidateIds: ["demo", "support"],
      source: "routine_activation",
      offerOutcome: "ignored",
      outcome: "declined",
    });
  });

  it("surfaces recently ignored offer candidate ids for loop guard", async () => {
    const store = storeWith(null);
    const recentReader: RecentClarificationReader = {
      loadRecent: vi.fn(async () => pending({ mode: "offer", status: "declined" })),
    };

    const resolved = await resolvePendingClarification({
      store,
      recentReader,
      clarifier: {
        phraseQuestion: vi.fn(),
        mapReply: vi.fn(),
      },
      turn: turn("tell me about that again"),
    });

    expect(resolved).toEqual({
      kind: "normal",
      resolvedPending: false,
      suppressNewClarification: undefined,
      loopGuardCandidateIds: ["demo", "support"],
    });
  });

  it("maps a chosen retrieval-sense clarification to a one-turn document scope", async () => {
    const store = storeWith(retrievalSensePending());

    const resolved = await resolvePendingClarification({
      store,
      clarifier: {
        phraseQuestion: vi.fn(),
        mapReply: vi.fn(async () => ({ kind: "chosen" as const, id: "doc-hatha" })),
      },
      turn: turn("hatha"),
    });

    expect(store.clear).toHaveBeenCalledWith({ sessionId: "conv_1", outcome: "resolved" });
    expect(resolved).toEqual({
      kind: "retrieval_sense",
      resolvedPending: true,
      suppressNewClarification: true,
      documentScope: ["doc-hatha", "doc-hatha-es"],
      originalQuery: "How do I upload a document via the REST API? Give me a curl example.",
    });
  });
});
