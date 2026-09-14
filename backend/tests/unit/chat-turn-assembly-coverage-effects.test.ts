import { describe, expect, it, vi } from "vitest";

import { createConversationEngine } from "@radioso/conversation-engine";
import { ChatTurnAssembly } from "../../src/modules/chat/services/chatTurnAssembly.js";
import { DeferredClarificationStore } from "../../src/modules/chat/services/clarification/deferredClarificationStore.js";
import { resolvePendingClarification } from "../../src/modules/chat/services/clarification/pendingClarificationResolver.js";

describe("coverage routine assembly effects", () => {
  it("captures state and reactions against the final session until the host commits", async () => {
    const durableStore = { loadActive: vi.fn(async () => null), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
    const persistedReaction = vi.fn(async () => {});
    const original = { conversation: { id: "old", workspaceId: "w" }, agent: { id: "a", workspaceId: "w" }, userMessage: { id: "old-request" } };
    const final = { conversation: { id: "new", workspaceId: "w" }, agent: { id: "a", workspaceId: "w" }, userMessage: { id: "new-request" }, answerCoverageInteractionTrace: undefined };
    const assembly = new ChatTurnAssembly({
      coverageAssessorFactory: {
        createReactionRecorder: ({ onRecorded }: { onRecorded?: (reaction: unknown) => void }) => ({ record: async (reaction: unknown) => { await persistedReaction(); onRecorded?.(reaction); } }),
      },
      routineStore: durableStore,
      routineProvider: { forTurn: async () => ({ coverageActivator: { evaluateCandidates: () => [], activate: async () => null }, activator: { activate: async () => null }, runner: { resume: async () => ({ response: { answer: "" }, nextState: null }) } }) },
    } as never);
    const runtime = await (assembly as never as { coverageTurnRuntime: (s: unknown, i: unknown) => Promise<unknown> }).coverageTurnRuntime(original, { responseLanguage: Promise.resolve(undefined), getSession: () => final });
    const typed = runtime as { routineStore: { save: (s: unknown) => Promise<void> }; coverageReactionRecorder: { record: (r: unknown) => Promise<void> }; effects: (r: unknown) => { commitRoutineState: () => Promise<void>; commitCoverageReactions: () => Promise<void> } };
    await typed.routineStore.save({ sessionId: "new", routineId: "r", path: [], variables: {}, status: "active" });
    await typed.coverageReactionRecorder.record({ assessment: { availability: "assessed", coverage: "unanswered", reason: "insufficient_evidence", schemaVersion: 1 }, evaluationState: "evaluated", reactions: [] });
    expect(durableStore.save).not.toHaveBeenCalled();
    expect(persistedReaction).not.toHaveBeenCalled();
    const effects = typed.effects({ actions: [], trace: {}, awaitingDecision: undefined });
    await effects.commitRoutineState();
    await effects.commitCoverageReactions();
    expect(durableStore.save).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "new" }));
    expect(persistedReaction).toHaveBeenCalledOnce();
  });
});

it("projects coverage handoff and suspended approval effects without committing either carrier", async () => {
  const durableStore = { loadActive: vi.fn(async () => null), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
  const session = { conversation: { id: "conversation", workspaceId: "workspace" }, agent: { id: "agent", workspaceId: "workspace" }, userMessage: { id: "request" } };
  const assembly = new ChatTurnAssembly({
    coverageAssessorFactory: { createReactionRecorder: () => ({ record: async () => {} }) },
    routineStore: durableStore,
    routineProvider: { forTurn: async () => ({ coverageActivator: { evaluateCandidates: () => [], activate: async () => null }, activator: { activate: async () => null }, runner: { resume: async () => ({ response: { answer: "" }, nextState: null }) } }) },
  } as never);
  const runtime = await (assembly as never as { coverageTurnRuntime: (s: unknown, i: unknown) => Promise<unknown> }).coverageTurnRuntime(session, { responseLanguage: Promise.resolve(undefined) });
  const typed = runtime as { routineStore: { save: (s: unknown) => Promise<void> }; effects: (r: unknown) => { actions?: Array<{ type: string }>; handoff?: { routineId: string; stepId: string }; suspended?: boolean; pendingDecisionTransition?: { routineId: string; stepId: string }; commitRoutineState: () => Promise<void> } };
  await typed.routineStore.save({ sessionId: "conversation", routineId: "routine", path: [], variables: {}, status: "suspended" });
  const effects = typed.effects({ actions: [{ type: "routine.action", payload: {} }], handoff: { routineId: "routine", stepId: "handoff" }, awaitingDecision: { stepId: "approve", captureKey: "approval", options: [{ id: "yes", label: "Yes" }] } });
  expect(effects.handoff).toEqual({ routineId: "routine", stepId: "handoff" });
  expect(effects.suspended).toBe(true);
  expect(effects.pendingDecisionTransition).toMatchObject({ routineId: "routine", stepId: "approve" });
  expect(effects.actions?.map((action) => action.type)).toEqual(["routine.action", "approval.request"]);
  expect(durableStore.save).not.toHaveBeenCalled();
});

it("carries coverage activation clarification through the existing deferred clarification carrier", async () => {
  const durableStore = { loadActive: vi.fn(async () => null), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
  const clarifier = { phraseQuestion: vi.fn(async () => "Which follow-up do you need?"), mapReply: vi.fn() };
  let pending: Record<string, unknown> | null = null;
  const persistedClarifications = {
    loadPending: vi.fn(async () => pending),
    save: vi.fn(async (next) => { pending = next; }),
    clear: vi.fn(async () => { pending = null; }),
  };
  const clarificationStore = new DeferredClarificationStore(persistedClarifications);
  const session = { conversation: { id: "conversation", workspaceId: "workspace" }, agent: { id: "agent", workspaceId: "workspace" }, userMessage: { id: "request" } };
  const assembly = new ChatTurnAssembly({
    coverageAssessorFactory: { createReactionRecorder: () => ({ record: async () => {} }) },
    routineStore: durableStore,
    routineProvider: { forTurn: async () => ({ coverageActivator: {
      evaluateCandidates: () => [],
      activate: async () => ({
        kind: "clarify" as const,
        candidates: [{
          id: "coverage-follow-up",
          label: "Consultation",
          confidence: 0.8,
          payload: { routineId: "coverage-follow-up", variables: { source: "coverage" } },
        }],
      }),
    }, activator: { activate: async () => null }, runner: { resume: async () => ({ response: { answer: "" }, nextState: null }) } }) },
  } as never);
  const runtime = await (assembly as never as { coverageTurnRuntime: (s: unknown, i: unknown) => Promise<unknown> }).coverageTurnRuntime(session, {
    responseLanguage: Promise.resolve(undefined),
    clarification: { clarifier, store: clarificationStore },
  });
  const typed = runtime as {
    coverageRoutineActivator: { activate: (input: unknown) => Promise<unknown> };
    routineStore: unknown;
    routineRunner: unknown;
    clarifier: unknown;
    clarificationStore: typeof clarificationStore;
    effects: (result: unknown) => {
      clarificationTransition?: unknown;
      commitClarificationState?: () => Promise<void>;
    };
  };

  const events: unknown[] = [];
  const result = await createConversationEngine().attemptRoutine({
    agent: { id: "agent", name: "Assistant" },
    sessionId: "conversation",
    inputEvent: { id: "request", kind: "message", content: "I need help." },
    stores: { loadHistory: async () => [], appendEvent: async (event) => { events.push(event); } },
    directives: [],
    directiveMatcher: { match: async () => [] },
    routineStore: typed.routineStore,
    routineRunner: typed.routineRunner,
    routineActivator: typed.coverageRoutineActivator,
    clarifier: typed.clarifier,
    clarificationStore: typed.clarificationStore,
  });

  expect(result?.decision.reason).toBe("routine_activation_clarification");
  expect(clarifier.phraseQuestion).toHaveBeenCalledOnce();
  expect(events).toHaveLength(2);
  const effects = typed.effects(result);
  expect(effects.clarificationTransition).toMatchObject({
    kind: "save",
    pending: {
      source: "routine_activation",
      candidates: [expect.objectContaining({ id: "coverage-follow-up" })],
      status: "pending",
    },
  });
  await effects.commitClarificationState?.();
  expect(persistedClarifications.save).toHaveBeenCalledWith(expect.objectContaining({
    source: "routine_activation",
    candidates: [expect.objectContaining({ id: "coverage-follow-up" })],
    status: "pending",
  }));

  clarifier.mapReply.mockResolvedValue({ kind: "chosen", id: "coverage-follow-up" });
  const replyStore = new DeferredClarificationStore(persistedClarifications);
  const continuation = await resolvePendingClarification({
    store: replyStore,
    clarifier,
    turn: {
      agent: { id: "agent", name: "Assistant" },
      sessionId: "conversation",
      inputEvent: { id: "selection", kind: "message", content: "Consultation" },
      history: [],
      stagedContext: [],
      steering: [],
    },
  });
  expect(continuation).toMatchObject({ kind: "routine_activation", resolvedPending: true });
  await replyStore.commit();
  expect(persistedClarifications.clear).toHaveBeenCalledWith({ sessionId: "conversation", outcome: "resolved" });

  const selected = continuation.kind === "routine_activation"
    ? await createConversationEngine().attemptRoutine({
        agent: { id: "agent", name: "Assistant" },
        sessionId: "conversation",
        inputEvent: { id: "selection", kind: "message", content: "Consultation" },
        stores: { loadHistory: async () => [], appendEvent: async () => {} },
        directives: [],
        directiveMatcher: { match: async () => [] },
        routineStore: typed.routineStore,
        routineRunner: typed.routineRunner,
        routineActivator: continuation.activator,
      })
    : null;
  expect(selected?.routineExecution?.routineId).toBe("coverage-follow-up");
});
