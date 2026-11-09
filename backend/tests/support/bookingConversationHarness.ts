import type {
  ConversationEvent,
  ConversationModelGateway,
  ProcessTurnResult,
  RoutineState,
} from "@radioso/conversation-contract";
import { DefaultConversationEngine } from "@radioso/conversation-engine";
import {
  InMemoryConversationRoutineStore,
  InMemoryConversationStores,
  type RoutineRegistration,
} from "@radioso/conversation-defaults";

import { compileRoutineDefinition, createRoutineTurnProvider } from "../../src/modules/routines/public.js";
import type { RoutineDefinition } from "../../src/modules/routines/public.js";

/**
 * A booking conversation driven through the production routine wiring: the routines module's
 * turn provider (real activator, next-step selector, step renderer, reentry gate, and
 * completed-routine correction, with the shipped prompts) and the engine's routine pass. Only
 * the model is the caller's, scripted in a unit test or a real one in a live check. A turn no
 * routine claims would go to normal answering; the harness records the visitor's message and a
 * fixed answer in its place, so later turns read them as history.
 */

const AGENT = { id: "agent_1", name: "Assistant" };
const SESSION_ID = "conversation_1";
const now = new Date("2026-11-01T00:00:00.000Z");

export const BOOK_STAY_ROUTINE_ID = "routine:agent_1:book-stay:v1";

const transition = (fromStep: string, toRef: string, ordinal: number, guard?: string): RoutineDefinition["transitions"][number] => ({
  fromStep,
  toRef,
  guardKind: guard ? "llm" : "default",
  guardText: guard ?? null,
  outcomeStatus: null,
  counterLimit: null,
  fieldRef: null,
  fieldOp: null,
  fieldValue: null,
  fieldValues: null,
  fieldUnit: null,
  ordinal,
});

/**
 * A stay booking whose dates may be changed after it ends. A visitor who is only looking ends
 * it on a `complete` ending that tells no one; a request with dates ends on one that notifies
 * the booking team.
 */
export const bookStayRoutine: RoutineDefinition = {
  id: BOOK_STAY_ROUTINE_ID,
  agentId: AGENT.id,
  lineageId: "lineage_book_stay",
  version: 1,
  enabled: true,
  createdAt: now,
  updatedAt: now,
  name: "Book a stay",
  activation: {
    triggerDescription: "the visitor wants to book a stay at the guest house",
    gateRef: null,
    priority: 0,
    reentryMode: "always",
  },
  slots: [
    { stableSlotId: "slot_arrival", key: "arrival", type: "date", required: true, mutable: true, description: "The day the visitor arrives.", ordinal: 0 },
    { stableSlotId: "slot_departure", key: "departure", type: "date", required: true, mutable: true, description: "The day the visitor leaves.", ordinal: 1 },
  ],
  steps: [
    {
      stableStepId: "dates",
      kind: "chat",
      instruction: "Ask for the arrival date {{slot.arrival}} and the departure date {{slot.departure}}",
      toolRef: null,
      actionType: null,
      ordinal: 0,
      metadata: {},
    },
  ],
  transitions: [
    transition("dates", "just_looking", 0, "the visitor says they are only looking and do not want to book"),
    transition("dates", "requested", 1),
  ],
  terminals: [
    { stableStepId: "just_looking", kind: "complete", instruction: "Tell them they are welcome to book whenever they like.", ordinal: 0 },
    {
      stableStepId: "requested",
      kind: "complete",
      instruction: "Tell them the booking team will confirm the stay.",
      ordinal: 1,
      operatorNotice: { subject: "New stay request", intro: null },
    },
  ],
};

const registration = (): RoutineRegistration => ({
  routine: compileRoutineDefinition(bookStayRoutine),
  trigger: { description: bookStayRoutine.activation.triggerDescription, priority: bookStayRoutine.activation.priority },
});

const turnProvider = () => createRoutineTurnProvider({
  agentSkillRepository: { listByAgent: async () => [] },
  capabilityPolicy: { can: async () => ({ allowed: true }) },
  clusteringEmbeddings: {},
  embeddingModelForWorkspace: async () => "unused",
  logger: { debug: () => undefined, warn: () => undefined },
  publishedRoutineSource: {
    load: async () => [registration()],
    loadPinned: async () => [],
    loadPreview: async () => [],
  },
  routineDefinitionRepository: {},
  routineInvocableSkillNames: { listByKindForAgent: async () => ({ webhook: [], customer_email: [], slack: [] }) },
  routineRegistrations: [],
  routineTriggerEmbeddingService: { persistPublished: async () => undefined },
  skillExecutorRegistry: {},
  approvalResumeEffectJournal: {},
  turnPlanAdapters: {
    activator: <T>({ fallback }: { fallback: T }) => fallback,
    reentryGate: <T>({ fallback }: { fallback: T }) => fallback,
    slotCorrection: <T>({ fallback }: { fallback: T }) => fallback,
  },
} as unknown as Parameters<typeof createRoutineTurnProvider>[0]);

export interface BookingConversation {
  /** Sends one visitor message: the turn a routine claimed, or null when normal answering would have it. */
  send(content: string): Promise<ProcessTurnResult | null>;
  /** The routine record the conversation keeps after the last turn. */
  routineState(): Promise<RoutineState | null>;
}

/** The answer recorded in place of a turn normal answering would have written. */
export const NORMAL_ANSWER = "A double room is 120 euro a night, breakfast included.";

export const startBookingConversation = async (
  modelGateway: ConversationModelGateway,
  seed: { completed?: RoutineState; history?: Array<{ role: "user" | "assistant"; content: string }> } = {},
): Promise<BookingConversation> => {
  const stores = new InMemoryConversationStores();
  const routineStore = new InMemoryConversationRoutineStore();
  if (seed.completed) {
    await routineStore.save({ ...seed.completed, sessionId: SESSION_ID });
  }
  let sequence = 0;
  const append = async (role: "user" | "assistant", content: string): Promise<void> => {
    const event: ConversationEvent = {
      id: `seed_${++sequence}`,
      sessionId: SESSION_ID,
      kind: role === "user" ? "message" : "assistant.response",
      role,
      content,
      createdAt: new Date(now.getTime() + sequence * 1_000).toISOString(),
    };
    await stores.appendEvent(event);
  };
  for (const message of seed.history ?? []) {
    await append(message.role, message.content);
  }
  const provider = turnProvider();
  const engine = new DefaultConversationEngine();

  return {
    async send(content) {
      const ports = await provider.forTurn({ modelGateway, agentId: AGENT.id });
      if (!ports) {
        throw new Error("the booking routine did not load");
      }
      const result = await engine.attemptRoutine({
        agent: AGENT,
        sessionId: SESSION_ID,
        inputEvent: { id: `input_${++sequence}`, kind: "message", content },
        stores,
        routineStore,
        routineRunner: ports.runner,
        routineActivator: ports.activator,
        ...(ports.reentryGate ? { routineReentryGate: ports.reentryGate } : {}),
        ...(ports.slotCorrection ? { routineSlotCorrection: ports.slotCorrection } : {}),
      });
      if (!result) {
        await append("user", content);
        await append("assistant", NORMAL_ANSWER);
      }
      return result;
    },
    async routineState() {
      return (await routineStore.loadActive({ sessionId: SESSION_ID }))
        ?? (await routineStore.loadCompleted({ sessionId: SESSION_ID }))[0]
        ?? null;
    },
  };
};
