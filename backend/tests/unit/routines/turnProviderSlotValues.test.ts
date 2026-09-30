import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  Routine,
  TurnContext,
} from "@radioso/conversation-contract";
import type { RoutineRegistration } from "@radioso/conversation-defaults";

import { createRoutineTurnProvider } from "../../../src/modules/routines/turnProvider.js";

// Proves the wiring described by the review of #1355: `forTurn`'s `includeSlotValues`
// option is the only thing that makes the real engine (`DefaultRoutineRunner`, not a
// fake) include a routine's captured slot values on its trace. Every live conversation
// leaves it unset, so the trace it builds — the one a customer's persisted turn copies
// verbatim — never carries a value in the first place; only a caller that explicitly
// opts in (the Test Chat / eval replay runner) gets one.

const turn: TurnContext = {
  agent: { id: "agent-1", name: "Assistant" },
  sessionId: "conversation-1",
  inputEvent: { id: "message-1", kind: "message", content: "guest@example.com" },
  history: [],
  stagedContext: [],
  steering: [],
};

const slotRoutine: Routine = {
  id: "slot-routine",
  rootStepId: "ask_email",
  slots: [{ id: "s1", key: "email", type: "email", required: true }],
  steps: [
    { id: "ask_email", kind: "chat", action: "Ask for email.", metadata: { collectsSlots: ["email"] } },
    { id: "done", kind: "terminal", action: "Thanks." },
  ],
  transitions: [{ from: "ask_email", to: "done", condition: "always", guard: { kind: "default" } }],
};

const registration: RoutineRegistration = {
  routine: slotRoutine,
  trigger: { description: "Collect an email", priority: 1 },
};

const dependencies = () => ({
  agentSkillRepository: { listByAgent: vi.fn(async () => []) },
  capabilityPolicy: { can: vi.fn(async () => ({ allowed: true })) },
  clusteringEmbeddings: {},
  embeddingModelForWorkspace: vi.fn(async () => "unused"),
  logger: { debug: vi.fn(), warn: vi.fn() },
  publishedRoutineSource: {
    load: vi.fn(async (): Promise<RoutineRegistration[]> => [registration]),
    loadPinned: vi.fn(async (): Promise<RoutineRegistration[]> => []),
    loadPreview: vi.fn(async (): Promise<RoutineRegistration[]> => []),
  },
  routineDefinitionRepository: {},
  routineInvocableSkillNames: { listByKindForAgent: vi.fn(async () => ({ webhook: [], customer_email: [], slack: [] })) },
  routineRegistrations: [],
  routineTriggerEmbeddingService: { persistPublished: vi.fn() },
  skillExecutorRegistry: {},
  turnPlanAdapters: {
    activator: ({ fallback }: { fallback: unknown }) => fallback,
    reentryGate: ({ fallback }: { fallback: unknown }) => fallback,
    slotCorrection: ({ fallback }: { fallback: unknown }) => fallback,
  },
});

// Auto-advances via the routine's single default-guarded transition, so no model call
// is needed to decide where the turn lands — only to render the terminal step's reply.
const gateway = (): ConversationModelGateway => ({
  complete: vi.fn(async () => ({ text: "Thanks." })),
});

describe("routine turn provider slot values", () => {
  it("omits slot values from a real engine's trace when the caller does not opt in (every live conversation)", async () => {
    const provider = createRoutineTurnProvider(dependencies() as never);
    const ports = await provider.forTurn({ modelGateway: gateway(), agentId: "agent-1" });

    const result = await ports!.runner.resume({
      turn,
      state: { sessionId: turn.sessionId, routineId: "slot-routine", path: [], variables: { email: "guest@example.com" }, status: "active" },
      activationTurn: true,
    });

    expect(result.trace).not.toHaveProperty("slotValues");
  });

  it("includes slot values on a real engine's trace only when the caller opts in (the Test Chat / eval replay runner)", async () => {
    const provider = createRoutineTurnProvider(dependencies() as never);
    const ports = await provider.forTurn({ modelGateway: gateway(), agentId: "agent-1", includeSlotValues: true });

    const result = await ports!.runner.resume({
      turn,
      state: { sessionId: turn.sessionId, routineId: "slot-routine", path: [], variables: { email: "guest@example.com" }, status: "active" },
      activationTurn: true,
    });

    expect(result.trace?.slotValues).toEqual([{ key: "email", type: "email", value: "guest@example.com" }]);
  });
});
