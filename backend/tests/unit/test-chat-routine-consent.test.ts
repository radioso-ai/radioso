import { describe, expect, it, vi } from "vitest";

import { DefaultConversationEngine } from "@radioso/conversation-engine";
import type { RoutineRegistration } from "@radioso/conversation-defaults";

import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import type { ChatGatewayInput } from "../../src/modules/chat/contracts/chatGateway.js";
import type { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { TestExecutionHistoryEntry } from "../../src/modules/test-execution/public.js";
import { TrustedTestExecutionRunnerAdapter } from "../../src/modules/chat/services/trustedTestExecutionRunnerAdapter.js";
import { WorkbenchReplayRunner } from "../../src/modules/chat/services/workbenchReplayRunner.js";
import { compileRoutineDefinition, type RoutineDefinition } from "../../src/modules/routines/public.js";
import { createRoutineTurnProvider } from "../../src/modules/routines/turnProvider.js";
import { SessionRoutineConsentStore } from "../../src/modules/chat/services/routines/sessionRoutineConsentStore.js";
import { createRoutineConsentTurnPort } from "../../src/modules/routines/consent/consentTurnPort.js";
import { routineConsentWordingVersionId } from "../../src/shared/domain/routineConsentWording.js";
import { DefaultAllowCapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import { conversationQualityAgentConfig } from "../fixtures/conversation-quality/agent.js";
import { createAuditService } from "../support/fakes.js";

const ROUTINE_ID = "routine-class-booking";
const wording = {
  locale: "en",
  body: "We ask about injuries only to adapt your class. Your answer stays with this booking.",
  agreeLabel: "I agree",
  declineLabel: "No thanks",
};

// A class booking: a name, then an injury, a sensitive field the consent covers.
const classBooking: RoutineDefinition = {
  id: ROUTINE_ID,
  agentId: "agent-1",
  lineageId: ROUTINE_ID,
  name: "Book a class",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "The visitor wants to book a class.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
  slots: [
    { stableSlotId: "slot_name", key: "name", type: "text", required: true, description: "The visitor's name", ordinal: 0 },
    { stableSlotId: "slot_injury", key: "injury", type: "text", required: true, description: "Any injury", ordinal: 1, sensitivity: "sensitive" },
  ],
  steps: [
    { stableStepId: "ask_name", kind: "chat", instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} },
    { stableStepId: "ask_injury", kind: "chat", instruction: "Ask about {{slot.injury}}.", toolRef: null, ordinal: 1, metadata: {} },
  ],
  transitions: [
    { fromStep: "ask_name", toRef: "ask_injury", guardKind: "default", guardText: null, ordinal: 0 },
    { fromStep: "ask_injury", toRef: "done", guardKind: "default", guardText: null, ordinal: 1 },
  ],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm the booking.", ordinal: 0 }],
  consents: [{ key: "health", slotKeys: ["injury"], variants: [wording], onDecline: "continue" }],
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
};

const revision: AgentRevision = {
  id: "44444444-4444-4444-8444-444444444444",
  snapshot: { customInstruction: "", directives: [], routines: [], contextVariableEnablements: [] },
  sourceDraftGeneration: 1,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date(0),
  publishedAt: null,
  publishedVersion: null,
};

// What the scripted model reads a message as: slot values, and a reply to the consent.
const slotValues: Record<string, Record<string, string>> = {
  "My name is Ada": { name: "Ada" },
  "Yes, and I have a sore knee": { injury: "sore knee" },
  "I have a sore knee": { injury: "sore knee" },
};
const consentReadings: Record<string, string> = { "Yes, and I have a sore knee": "granted", "No": "declined" };

const scriptedModel = {
  answer: vi.fn(async (input: ChatGatewayInput) => {
    const prompt = input.systemPrompt ?? "";
    if (prompt.includes("wants to start any registered routine")) {
      return JSON.stringify({ matches: [{ routineId: ROUTINE_ID, confidence: 0.95, variables: {} }] });
    }
    if (prompt.includes("A person was just shown the consent request")) {
      return JSON.stringify({ decision: consentReadings[input.query] ?? "unclear" });
    }
    if (prompt.includes("answered without clearly agreeing or")) return "We use it only to adapt your class.";
    if (prompt.includes("claimsAuthority") || prompt.includes("Declared slots")) {
      return JSON.stringify({ variables: slotValues[input.query] ?? {}, claimsAuthority: false, condition: null, offTopic: false });
    }
    return `[step reply to: ${input.query}]`;
  }),
};

const presenter = (): ChatAnswerPresenter => {
  const present = (answer: string) => ({ answer, skillName: "routine", skillOutcome: "completed", skillStatus: "completed" });
  return { presentNonRetrievalAnswer: present, presentRoutineAnswer: present } as unknown as ChatAnswerPresenter;
};

/**
 * The workspace's consent records, as composition binds them for live chat. Test Chat keeps no
 * conversation row, so it must never read or write them.
 */
const workspaceRecords = () => ({
  standingByConsent: vi.fn(async () => { throw new Error("Test Chat read the workspace's consent records"); }),
  latestPrompt: vi.fn(async () => { throw new Error("Test Chat read the workspace's consent records"); }),
});

/** Test Chat on one side: each message runs through the trusted runner with the side's stored history and continuation. */
const testChat = () => {
  const records = workspaceRecords();
  const registration: RoutineRegistration = {
    routine: compileRoutineDefinition(classBooking),
    trigger: { description: classBooking.activation.triggerDescription, priority: 0 },
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
    routineInvocableSkillNames: { listByKindForAgent: vi.fn(async () => ({ webhook: [], customer_email: [], slack: [] })) } as never,
    routineRegistrations: [],
    routineTriggerEmbeddingService: { persistPublished: vi.fn() },
    skillExecutorRegistry: {} as never,
    approvalResumeEffectJournal: {} as never,
    turnPlanAdapters: {
      activator: ({ fallback }) => fallback,
      reentryGate: ({ fallback }) => fallback,
      slotCorrection: ({ fallback }) => fallback,
    },
    consentStore: records,
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

  const history: TestExecutionHistoryEntry[] = [];
  let continuation: unknown = null;
  let turns = 0;
  const send = async (message: string) => {
    turns += 1;
    const turnId = `turn-${turns}`;
    const stream = adapter.stream({
      workspaceId: "ws-1",
      agentId: "agent-1",
      candidateRevision: revision,
      conversationId: "test-chat-side-1",
      message,
      history: [...history],
      continuation,
      testValues: [],
      executionMode: "safe_test",
      skillEffects: "suppressed",
      accountId: "account-1",
    });
    let step = await stream.next();
    while (!step.done) step = await stream.next();
    const result = step.value;
    const now = new Date();
    history.push(
      { turnId, role: "user", content: message, attemptId: "attempt-1", createdAt: now },
      { turnId, role: "assistant", content: result.answer, messageId: result.messageId, attemptId: "attempt-1", createdAt: now },
    );
    continuation = result.continuation;
    return result;
  };
  const routineState = () =>
    (continuation as { routineState: { status: string; variables: Record<string, unknown> } | null } | null)?.routineState ?? null;
  return { send, routineState, records };
};

describe("Test Chat routine consent (#1544)", () => {
  it("keeps a granted consent across turns, so the step asks for the covered field and stores the answer", async () => {
    const chat = testChat();
    await chat.send("I want to book a class");

    const asked = await chat.send("My name is Ada");
    // Test Chat shows a reply's text alone, so the two choices follow the wording as lines.
    expect(asked.answer).toBe(`${wording.body}\n\n${wording.agreeLabel}\n\n${wording.declineLabel}`);

    const granted = await chat.send("Yes, and I have a sore knee");
    // The message that grants consent fills no covered field; the step asks for it next.
    expect(granted.answer).toContain("[step reply to:");
    expect(chat.routineState()?.variables).toEqual({ name: "Ada" });

    await chat.send("I have a sore knee");
    expect(chat.routineState()).toMatchObject({ variables: { name: "Ada", injury: "sore knee" } });
    // Test Chat keeps no conversation row: the workspace's consent records are never consulted.
    expect(chat.records.standingByConsent).not.toHaveBeenCalled();
    expect(chat.records.latestPrompt).not.toHaveBeenCalled();
  });
});

describe("SessionRoutineConsentStore (#1544)", () => {
  const versionId = routineConsentWordingVersionId(wording);
  const consent = { conversationId: "test-chat-side-1", routineId: ROUTINE_ID, consentKey: "health" };
  const standing = (store: SessionRoutineConsentStore, versionIdsByConsent: Record<string, string[]>) =>
    store.standingByConsent({ routineId: ROUTINE_ID, versionIdsByConsent: new Map(Object.entries(versionIdsByConsent)) });
  const decided = (decision: "granted" | "declined", decidedWording = wording) => ({
    kind: "decided" as const, routineId: ROUTINE_ID, consentKey: "health", slotKeys: ["injury"], decision, method: "reply" as const, defaulted: false, wording: decidedWording,
  });

  it("holds the decision on any wording of the consent, and the reply that showed it last", async () => {
    const store = new SessionRoutineConsentStore();
    store.record({ events: [{ kind: "asked", routineId: ROUTINE_ID, consentKey: "health", reask: false, wording }], replyMessageId: "reply-1" });
    store.record({ events: [{ kind: "asked", routineId: ROUTINE_ID, consentKey: "health", reask: true, wording }], replyMessageId: "reply-2" });
    expect(await store.latestPrompt(consent)).toEqual({ messageId: "reply-2", wordingVersionId: versionId, locale: "en" });
    expect(await standing(store, { health: [versionId] })).toEqual(new Map());

    store.record({ events: [decided("declined")], replyMessageId: "reply-3" });
    expect(await standing(store, { health: ["another-version", versionId] })).toEqual(new Map([["health", "declined"]]));
    // A decision is kept on the wording it was given on; a consent whose wording changed asks again.
    expect(await standing(store, { health: ["another-version"] })).toEqual(new Map());
    expect(await standing(store, { other: [versionId] })).toEqual(new Map());
  });

  it("keeps the first decision on a wording, as the workspace's records do", async () => {
    const store = new SessionRoutineConsentStore();
    store.record({ events: [decided("declined")], replyMessageId: "reply-1" });
    store.record({ events: [decided("granted")], replyMessageId: "reply-2" });

    expect(await standing(store, { health: [versionId] })).toEqual(new Map([["health", "declined"]]));
    expect(new SessionRoutineConsentStore(store.snapshot()).snapshot()?.decisions).toHaveLength(1);
  });

  it("keeps nothing for a consent not asked, and carries what it holds into the next turn's store", async () => {
    const store = new SessionRoutineConsentStore();
    store.record({ events: [{ kind: "skipped", routineId: ROUTINE_ID, consentKey: "health", reason: "channel" }], replyMessageId: "reply-1" });
    expect(store.snapshot()).toBeNull();

    store.record({ events: [{ kind: "asked", routineId: ROUTINE_ID, consentKey: "health", reask: false, wording }], replyMessageId: "reply-1" });
    store.record({
      events: [{ kind: "decided", routineId: ROUTINE_ID, consentKey: "health", slotKeys: ["injury"], decision: "granted", method: "reply", defaulted: false, wording }],
      replyMessageId: "reply-2",
    });
    const next = new SessionRoutineConsentStore(store.snapshot());
    expect(await standing(next, { health: [versionId] })).toEqual(new Map([["health", "granted"]]));
    expect(await next.latestPrompt(consent)).toEqual({ messageId: "reply-1", wordingVersionId: versionId, locale: "en" });
  });
});

describe("a consent button clicked in a session no row is kept for (#1544)", () => {
  it("reads a click-shaped message in Test Chat, which shows the choices as text, as a reply to the wording the session showed last", async () => {
    const promptId = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
    const store = new SessionRoutineConsentStore();
    store.record({ events: [{ kind: "asked", routineId: ROUTINE_ID, consentKey: "health", reask: false, wording }], replyMessageId: promptId });
    const routine = compileRoutineDefinition(classBooking);
    const reader = { read: vi.fn(async () => "unclear" as const) };
    const port = createRoutineConsentTurnPort({
      facts: {
        conversationId: "test-chat-side-1",
        visitorId: null,
        sourceChannel: "workbench_replay",
        userMessage: { id: "message-2", inputMetadata: { method: "suggestion_click", suggestionSourceMessageId: promptId, suggestionId: "agree" } },
        preferredLocales: async () => [],
        agentDefaultLocale: "en",
        durable: false,
      },
      store,
      reader,
      answerer: { answer: vi.fn(async () => "") },
    });
    const turn = { agent: { id: "agent-1", name: "Classes" }, sessionId: "test-chat-side-1", inputEvent: { id: "message-2", kind: "message" as const, content: "I agree" }, history: [], stagedContext: [], steering: [] };

    expect(await port.read({ routine, consent: routine.consents![0], turn }))
      .toEqual({ decision: "unclear", method: "reply", wording });
    expect(reader.read).toHaveBeenCalledWith({ turn, wording });
  });
});
