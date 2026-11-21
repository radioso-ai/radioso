import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine } from "@radioso/conversation-engine";
import type { RoutineRegistration } from "@radioso/conversation-defaults";

import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import type { ChatGatewayInput } from "../../src/modules/chat/contracts/chatGateway.js";
import type { StoredReplyBlock } from "../../src/modules/chat/contracts/replyBlocks.js";
import type { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { exportTestExecutionReplayContinuation } from "../../src/modules/chat/services/testExecutionContinuation.js";
import { TrustedTestExecutionRunnerAdapter } from "../../src/modules/chat/services/trustedTestExecutionRunnerAdapter.js";
import { WorkbenchReplayRunner } from "../../src/modules/chat/services/workbenchReplayRunner.js";
import type { TestExecutionHistoryEntry } from "../../src/modules/test-execution/public.js";
import { compileRoutineDefinition, type RoutineDefinition } from "../../src/modules/routines/public.js";
import { createRoutineTurnProvider } from "../../src/modules/routines/turnProvider.js";
import { DefaultAllowCapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import { conversationQualityAgentConfig } from "../fixtures/conversation-quality/agent.js";
import { createAuditService } from "../support/fakes.js";

// A product finder in Test Chat (#1763): a search, a step that shows its results as cards and binds
// the visitor's pick, then a step that asks for an email. The run waits on the cards step, whose
// reply an earlier Test Chat turn stored with its cards.
const ROUTINE_ID = "routine-products";
const RUN_ID = "run-products-1";
const CARDS_MESSAGE_ID = "6a1d0c4e-5b2f-4c3d-8e9f-0a1b2c3d4e5f";
const OTHER_SIDE_MESSAGE_ID = "7b2e1d5f-6c3a-4d4e-9fa0-1b2c3d4e5f60";

const edge = (fromStep: string, toRef: string, ordinal: number): RoutineDefinition["transitions"][number] =>
  ({ fromStep, toRef, guardKind: "default", guardText: null, ordinal });

const productFinder: RoutineDefinition = {
  id: ROUTINE_ID,
  agentId: "agent-1",
  lineageId: ROUTINE_ID,
  name: "Product finder",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "The visitor looks for a product.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
  slots: [
    { stableSlotId: "slot_query", key: "query", type: "text", required: true, description: null, ordinal: 0 },
    { stableSlotId: "slot_chosen", key: "chosen", type: "item", required: true, description: null, ordinal: 1 },
    { stableSlotId: "slot_email", key: "email", type: "email", required: true, description: null, ordinal: 2 },
  ],
  steps: [
    { stableStepId: "ask", kind: "chat", instruction: "Ask what they look for. {{slot.query}}", toolRef: null, ordinal: 0, metadata: {} },
    { stableStepId: "search", kind: "tool", instruction: "Search.", toolRef: "search_products", ordinal: 1, metadata: {} },
    { stableStepId: "choose", kind: "chat", instruction: "Show the products.", toolRef: null, ordinal: 2, metadata: { present: { from: "search", selection: "single", slot: "chosen" } } },
    { stableStepId: "contact", kind: "chat", instruction: "You chose {{slot.chosen}}. Your email? {{slot.email}}", toolRef: null, ordinal: 3, metadata: {} },
  ],
  transitions: [edge("ask", "search", 0), edge("search", "choose", 1), edge("choose", "contact", 2), edge("contact", "done", 3)],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Thank them.", ordinal: 0 }],
  createdAt: new Date("2026-11-21T00:00:00.000Z"),
  updatedAt: new Date("2026-11-21T00:00:00.000Z"),
};

const revision: AgentRevision = {
  id: "55555555-5555-4555-8555-555555555555",
  snapshot: { customInstruction: "", directives: [], routines: [], contextVariableEnablements: [] },
  sourceDraftGeneration: 1,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date(0),
  publishedAt: null,
  publishedVersion: null,
};

// Cards built from a skill's card roles: the key is the record's numeric id, the subtitle its price.
const product = (id: number, title: string, price: number) => ({
  key: String(id),
  title,
  description: String(price),
  image: { imageId: `image-${id}`, width: 640, height: 480, alt: title },
  actions: [{ type: "select" as const }],
  fields: { id, title, price, thumbnail: `https://shop.example/${id}.png` },
});

const cards: StoredReplyBlock = {
  type: "item_list",
  id: "b1",
  layout: "carousel",
  selection: "single",
  caption: "Phones",
  items: [product(121, "Phone One", 499), product(122, "Phone Two", 549)],
  origin: { kind: "routine_step", skillName: "search_products", routineId: ROUTINE_ID, stepId: "choose", executionId: RUN_ID, slot: "chosen" },
};

const NUMBERED_CARDS = `1. "Phone One"\n2. "Phone Two"`;

// The selector returns the shown item's number only when its prompt numbers the cards; without
// them, it writes the visitor's words, as a model does.
const scriptedModel = {
  answer: vi.fn(async (input: ChatGatewayInput) => {
    const prompt = input.systemPrompt ?? "";
    if (prompt.includes("claimsAuthority") || prompt.includes("Declared slots")) {
      const chosen = prompt.includes(NUMBERED_CARDS) ? 2 : "the second one";
      return JSON.stringify({ variables: { chosen }, claimsAuthority: false, condition: null, offTopic: false });
    }
    return `[step reply to: ${input.query}]`;
  }),
};

const presenter = (): ChatAnswerPresenter => {
  const present = (answer: string) => ({ answer, skillName: "routine", skillOutcome: "completed", skillStatus: "completed" });
  return { presentNonRetrievalAnswer: present, presentRoutineAnswer: present } as unknown as ChatAnswerPresenter;
};

/** One Test Chat side, waiting on the cards step: an earlier turn showed the cards and stored them with its reply. */
const testChatAtCards = () => {
  const registration: RoutineRegistration = {
    routine: compileRoutineDefinition(productFinder),
    trigger: { description: productFinder.activation.triggerDescription, priority: 0 },
  };
  const routineProvider = createRoutineTurnProvider({
    agentSkillRepository: { listByAgent: vi.fn(async () => []) },
    capabilityPolicy: new DefaultAllowCapabilityPolicy(),
    clusteringEmbeddings: {
      embedForClustering: vi.fn(async ({ texts }: { texts: string[] }) => ({ vectors: texts.map(() => [1, 0]) })),
    } as never,
    embeddingModelForWorkspace: vi.fn(async () => "test-embedding"),
    logger: { debug: vi.fn(), warn: vi.fn() },
    publishedRoutineSource: {
      load: async () => [registration],
      loadPinned: async ({ routineIds }) => routineIds.includes(ROUTINE_ID) ? [registration] : [],
      loadPreview: async () => [],
    },
    routineDefinitionRepository: {
      searchActivationTriggerEmbeddings: vi.fn(async () => ({ matches: [], noVectorRoutineIds: [] })),
    },
    routineRegistrations: [],
    routineTriggerEmbeddingService: { persistPublished: vi.fn() },
    skillExecutorRegistry: {} as never,
    approvalResumeEffectJournal: {} as never,
    turnPlanAdapters: {
      activator: ({ fallback }) => fallback,
      reentryGate: ({ fallback }) => fallback,
      slotCorrection: ({ fallback }) => fallback,
    },
  });
  const replay = new WorkbenchReplayRunner({
    retrievalTurn: {
      interpret: async () => { throw new Error("a routine turn retrieves nothing"); },
      dispatch: async () => { throw new Error("a routine turn retrieves nothing"); },
    },
    auditService: createAuditService(),
    turnSkills: [],
    conversationEngine: new DefaultConversationEngine(),
    turnRouter: { classify: async () => ({ route: "direct", framing: { isIdentityQuestion: false } }) } as never,
    routineProvider,
    chatGateway: scriptedModel,
    chatAnswerPresenter: presenter(),
  });
  const adapter = new TrustedTestExecutionRunnerAdapter({
    replay,
    liveAgentConfig: { find: async () => ({ ...conversationQualityAgentConfig, assistantDefaultLocale: "en" }) },
    revisions: { findRevision: async () => revision },
  });

  const shownAt = new Date("2026-11-21T10:00:00.000Z");
  const history: TestExecutionHistoryEntry[] = [
    { turnId: "turn-1", role: "user", content: "I am looking for a phone", messageId: "8c3f2e60-7d4b-4e5f-a0b1-2c3d4e5f6071", attemptId: "attempt-1", createdAt: shownAt },
    // The transcript keeps what the reply's message stored of its cards, as the runner returned it.
    { turnId: "turn-1", role: "assistant", content: "Here are some phones.", messageId: CARDS_MESSAGE_ID, attemptId: "attempt-1", createdAt: shownAt, messageMetadata: { blocks: [cards] } },
  ];
  const continuation = exportTestExecutionReplayContinuation({
    routineState: { sessionId: "test-chat-side-1", routineId: ROUTINE_ID, executionId: RUN_ID, path: ["ask", "search", "choose"], variables: { query: "phone" }, status: "active" },
    pendingClarification: null,
    directiveState: null,
  });

  const send = async (message: string, itemSelection?: { messageId: string; blockId: string; itemKey: string }) => {
    const stream = adapter.stream({
      workspaceId: "ws-1",
      agentId: "agent-1",
      candidateRevision: revision,
      conversationId: "test-chat-side-1",
      message,
      ...(itemSelection ? { itemSelection } : {}),
      history,
      continuation,
      testValues: [],
      executionMode: "safe_test",
      skillEffects: "suppressed",
      accountId: "account-1",
    });
    let step = await stream.next();
    while (!step.done) step = await stream.next();
    const result = step.value;
    const routineState = (result.continuation as { routineState: { path: string[]; variables: Record<string, unknown> } | null }).routineState;
    return { result, routineState };
  };
  return { send };
};

const phoneTwo = { key: "122", title: "Phone Two", fields: { id: 122, title: "Phone Two", price: 549, thumbnail: "https://shop.example/122.png" } };

describe("Test Chat on a routine step that showed cards (#1763)", () => {
  it("fills the item from a typed answer that names a card by its place, against the cards the transcript kept", async () => {
    const { routineState } = await testChatAtCards().send("The second one please");

    expect(routineState?.variables.chosen).toEqual(phoneTwo);
    expect(routineState?.path.at(-1)).toBe("contact");
  });

  it("fills the item from a tapped card exactly as a pick in live chat does, with no selector call", async () => {
    scriptedModel.answer.mockClear();
    const { result, routineState } = await testChatAtCards().send("Phone Two", { messageId: CARDS_MESSAGE_ID, blockId: "b1", itemKey: "122" });

    expect(routineState?.variables.chosen).toEqual(phoneTwo);
    expect(routineState?.path.at(-1)).toBe("contact");
    const selectorCalls = scriptedModel.answer.mock.calls.filter(([input]) => (input.systemPrompt ?? "").includes("Declared slots"));
    expect(selectorCalls).toHaveLength(0);
    expect(JSON.stringify(result.turnTrace)).toContain("item_selected");
  });

  it("runs a tap on a card this side never showed, such as the other version's in a comparison, as the card's words", async () => {
    scriptedModel.answer.mockClear();
    const { routineState } = await testChatAtCards().send("Phone Two", { messageId: OTHER_SIDE_MESSAGE_ID, blockId: "b1", itemKey: "122" });

    // Read as typed, the card's title still names the card this side showed.
    const selectorCalls = scriptedModel.answer.mock.calls.filter(([input]) => (input.systemPrompt ?? "").includes("Declared slots"));
    expect(selectorCalls.length).toBeGreaterThan(0);
    expect(routineState?.variables.chosen).toEqual(phoneTwo);
  });
});
