import { describe, expect, it, vi } from "vitest";
import type { RoutineState } from "@radioso/conversation-contract";

import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { RetrievalTurnController } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import { AgentRevisionRuntimeResolver, type AgentRevision } from "../../src/modules/agents/public.js";
import type { RoutineDefinition } from "../../src/modules/routines/public.js";
import {
  createAuditService,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
} from "../support/fakes.js";

const WORKSPACE_ID = "workspace-1";

const directOnlyRetrievalTurn = () =>
  new RetrievalTurnController({
    async interpret() { throw new Error("retrieval is not prepared in these turns"); },
    async runInterpreted() { throw new Error("retrieval is not prepared in these turns"); },
    async runWithoutRetrieval() { throw new Error("retrieval is not prepared in these turns"); },
  } as never);

// A booking routine whose second step asks about an injury, a sensitive field.
const booking: RoutineDefinition = {
  id: "def_booking",
  agentId: "agent_1",
  lineageId: "def_booking",
  name: "booking",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "A visitor wants to book a class.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
  slots: [
    { stableSlotId: "slot_class", key: "class_name", type: "text", required: true, description: null, ordinal: 0 },
    { stableSlotId: "slot_injury", key: "injury", type: "text", required: true, description: null, ordinal: 1, sensitivity: "sensitive" },
  ],
  steps: [
    { stableStepId: "ask_class", kind: "chat", instruction: "Ask for {{slot.class_name}}.", toolRef: null, ordinal: 0, metadata: {} },
    { stableStepId: "ask_injury", kind: "chat", instruction: "Ask about {{slot.injury}}.", toolRef: null, ordinal: 1, metadata: {} },
  ],
  transitions: [],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: null, ordinal: 0 }],
  createdAt: new Date("2026-10-25T00:00:00.000Z"),
  updatedAt: new Date("2026-10-25T00:00:00.000Z"),
};

const revision: AgentRevision = {
  id: "revision-1",
  snapshot: { customInstruction: "", directives: [], routines: [booking], contextVariableEnablements: [] },
  sourceDraftGeneration: 1,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date(),
  publishedAt: new Date(),
  publishedVersion: 1,
};

const harness = async (path: string[]) => {
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
  const conversation = await conversationRepository.create({ workspaceId: WORKSPACE_ID, agentRevisionId: revision.id });
  const facetExtractionJobs = { enqueue: vi.fn(async () => ({ id: "job-1", created: true })) };
  const active: RoutineState = { sessionId: conversation.id, routineId: booking.id, path, variables: { class_name: "Yoga" }, status: "active" };
  const preparer = new ChatSessionPreparer(
    conversationRepository,
    messageRepository,
    directOnlyRetrievalTurn(),
    createAuditService(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    facetExtractionJobs,
    undefined,
    new AgentRevisionRuntimeResolver({ findCurrentPublished: async () => revision, findRevision: async () => revision }),
    undefined,
    undefined,
    { loadActive: async ({ sessionId }) => (sessionId === conversation.id ? active : null) },
  );
  const prepare = (query: string) => preparer.prepare(
    { workspaceId: WORKSPACE_ID, conversationId: conversation.id, query },
    { skipRetrieval: true },
  );
  return { prepare, messageRepository, facetExtractionJobs };
};

describe("ChatSessionPreparer and a routine waiting on a sensitive field (#1543)", () => {
  it("marks the visitor's answer when the message is created, and queues no facet for it", async () => {
    const { prepare, messageRepository, facetExtractionJobs } = await harness(["ask_class", "ask_injury"]);

    const session = await prepare("I tore my ACL skiing");

    expect(session.userMessage.metadata?.sensitiveSlotKeys).toEqual(["injury"]);
    const stored = await messageRepository.findByIdAndWorkspaceId(WORKSPACE_ID, session.userMessage.id);
    expect(stored?.metadata?.sensitiveSlotKeys).toEqual(["injury"]);
    expect(facetExtractionJobs.enqueue).not.toHaveBeenCalled();
  });

  it("leaves a message on a step that collects only normal fields unmarked, and queues its facet", async () => {
    const { prepare, facetExtractionJobs } = await harness([]);

    const session = await prepare("Yoga, please");

    expect(session.userMessage.metadata?.sensitiveSlotKeys).toBeUndefined();
    expect(facetExtractionJobs.enqueue).toHaveBeenCalledOnce();
  });
});
