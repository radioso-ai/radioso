import { randomUUID } from "node:crypto";

import { createConversationEngine } from "@radioso/conversation-engine";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createWorkspaceConversationDataErasure } from "../../src/app/composition/conversationErasure.js";
import { composeRoutineTurnProvider } from "../../src/app/composition/routineTurnProvider.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { AuditEventRepository } from "../../src/db/repositories/auditEventRepository.js";
import { HistoryItemsRepository } from "../../src/db/repositories/historyItemsRepository.js";
import { ConversationActivityRepository } from "../../src/db/repositories/conversationActivityRepository.js";
import { ConversationRepository } from "../../src/db/repositories/conversationRepository.js";
import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import { PersonalCredentialLifecycleRepository } from "../../src/db/repositories/personalCredentialLifecycleRepository.js";
import { RoutineStateRepository } from "../../src/db/repositories/routineStateRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AgentRevisionRuntimeResolver, type AgentRevision } from "../../src/modules/agents/public.js";
import type { RoutineRegistration } from "../../src/modules/chat/composition.js";
import { PostgresAssistantTurnPersistence } from "../../src/modules/chat/infra/postgresAssistantTurnPersistence.js";
import { ChatHistoryService } from "../../src/modules/chat/services/chatHistoryService.js";
import { ChatService, type ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { buildChatTurnRuntime } from "../../src/modules/chat/services/chatTurnRuntime.js";
import { MissingFallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import { legacyAgentWithoutWorkspace } from "../../src/modules/chat/services/legacyWorkspaceAgent.js";
import { compileRoutineDefinition, createRoutineConsentTelemetry, type RoutineDefinition } from "../../src/modules/routines/public.js";
import type { UserMessageInputMetadata } from "../../src/shared/domain/chatInputMetadata.js";
import { routineConsentWordingVersionId } from "../../src/shared/domain/routineConsentWording.js";
import { Database } from "../../src/shared/infra/database.js";
import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import { createAuditService, InMemoryAuditEventRepository } from "../support/fakes.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const ROUTINE_ID = "routine-class-booking";
const wording = {
  locale: "en",
  body: "We ask about injuries only to adapt your class. Your answer stays with this booking.",
  agreeLabel: "I agree",
  declineLabel: "No thanks",
};

// A class booking: a name, then an injury, a sensitive field the consent covers.
const classBooking = (onDecline: "continue" | "handoff"): RoutineDefinition => ({
  id: ROUTINE_ID,
  agentId: "agent",
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
  consents: [{ key: "health", slotKeys: ["injury"], variants: [wording], onDecline }],
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
});

// What the scripted model reads a visitor's message as: slot values, and a reply to the consent.
const slotValues: Record<string, Record<string, string>> = {
  "My name is Ada": { name: "Ada" },
  "Yes, and I have a sore knee": { injury: "sore knee" },
  "I have a sore knee": { injury: "sore knee" },
};
const consentReadings: Record<string, string> = {
  "Yes, and I have a sore knee": "granted",
  "No": "declined",
};
const UNCLEAR_ANSWER = "We use it only to adapt your class.";

/** The model, scripted by the system prompt each routine call sends. */
const scriptedModel: ChatGateway = {
  async answer(input) {
    const prompt = input.systemPrompt ?? "";
    if (prompt.includes("wants to start any registered routine")) {
      return JSON.stringify({ matches: [{ routineId: ROUTINE_ID, confidence: 0.95, variables: {} }] });
    }
    if (prompt.includes("A person was just shown the consent request")) {
      return JSON.stringify({ decision: consentReadings[input.query] ?? "unclear" });
    }
    if (prompt.includes("answered without clearly agreeing or")) {
      return UNCLEAR_ANSWER;
    }
    if (prompt.includes("claimsAuthority") || prompt.includes("Declared slots")) {
      return JSON.stringify({ variables: slotValues[input.query] ?? {}, claimsAuthority: false, condition: null, offTopic: false });
    }
    return `[step reply to: ${input.query}]`;
  },
  async *streamAnswer() {
    throw new Error("consent turns run the non-streaming path");
  },
};

describeIntegration("routine consent through a chat turn (Postgres, #1544)", () => {
  const database = new Database(integrationDatabaseUrl);
  const seededAccountIds: string[] = [];
  const metrics = new MetricsRegistry();
  const logged: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    const lifecycle = new PersonalCredentialLifecycleRepository(database.kysely, createWorkspaceConversationDataErasure());
    for (const accountId of seededAccountIds) {
      await lifecycle.deleteAccount({
        accountId,
        auditEvent: { accountId, eventType: "account.delete", eventStatus: "success", metadata: {} },
      });
    }
    await database.close().catch(() => undefined);
  });

  /** A workspace whose published agent runs the class booking, and one conversation with it on `sourceChannel`. */
  const startConversation = async (input: { onDecline?: "continue" | "handoff"; sourceChannel?: string } = {}) => {
    const definition = classBooking(input.onDecline ?? "continue");
    const account = await new AccountRepository(database.kysely).create({
      name: "Consent chat",
      email: `consent-chat-${randomUUID()}@classes.example`,
      passwordHash: "hash",
    });
    seededAccountIds.push(account.id);
    const workspace = await new WorkspaceRepository(database.kysely).create(account.id, "Consent chat");
    const agentId = randomUUID();
    const revisionId = randomUUID();
    const conversationId = randomUUID();
    await database.query("INSERT INTO agents (id, workspace_id, name) VALUES ($1, $2, 'Classes')", [agentId, workspace.id]);
    await database.query(
      `INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation, published_at, published_version)
       VALUES ($1, $2, $3, '{}'::jsonb, 1, now(), 1)`,
      [revisionId, agentId, workspace.id],
    );
    const [visitor] = await database.query<{ id: string }>(
      "INSERT INTO visitors (workspace_id, visitor_key, conversation_count) VALUES ($1, $2, 1) RETURNING id",
      [workspace.id, `visitor-${randomUUID()}`],
    );
    await database.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, visitor_id, source_channel) VALUES ($1, $2, $3, $4, $5)",
      [conversationId, workspace.id, agentId, visitor.id, input.sourceChannel ?? "website_embed"],
    );

    const revision = {
      id: revisionId,
      snapshot: { customInstruction: "", directives: [], routines: [definition], contextVariableEnablements: [] },
      sourceDraftGeneration: 1,
      sourceBasePublishedRevisionId: null,
      createdAt: new Date(),
      publishedAt: new Date(),
      publishedVersion: 1,
    } as unknown as AgentRevision;
    const registration: RoutineRegistration = {
      routine: compileRoutineDefinition(definition),
      trigger: { description: definition.activation.triggerDescription, priority: 0 },
    };
    const logger = {
      debug: () => undefined,
      info: (fields: Record<string, unknown>) => void logged.push(fields),
      warn: () => undefined,
      error: (fields: Record<string, unknown>) => void logged.push(fields),
    };
    const routineProvider = composeRoutineTurnProvider({
      composition: {
        capabilityPolicy: { can: async () => ({ allowed: true }) },
        publishedRoutineRegistrationSource: {
          load: async () => [registration],
          loadPinned: async ({ routineIds }: { routineIds: string[] }) => routineIds.includes(ROUTINE_ID) ? [registration] : [],
          loadPreview: async () => [],
        },
        routineRegistrations: [],
        skillExecutorRegistry: {},
      },
      db: database.kysely,
      agentSkillRepository: { findByAgentAndName: async () => null, listByAgent: async () => [] },
      logger,
      routineDefinitionRepository: {},
      approvalResumeEffectJournal: {},
      clusteringEmbeddings: {},
      embeddingModelForWorkspace: async () => "unused",
      metricsRegistry: metrics,
      routineInvocableSkillNames: { listByKindForAgent: async () => ({ webhook: [], customer_email: [], slack: [] }) },
      routineTriggerEmbeddingService: { persistPublished: async () => undefined },
    } as unknown as Parameters<typeof composeRoutineTurnProvider>[0]);

    const chat = new ChatService({
      conversationRepository: new ConversationRepository(database.kysely),
      messageRepository: new MessageRepository(database.kysely),
      retrievalTurn: {
        interpret: async () => { throw new Error("a routine turn retrieves nothing"); },
        dispatch: async () => { throw new Error("a routine turn retrieves nothing"); },
      },
      chatGateway: scriptedModel,
      auditService: createAuditService(new InMemoryAuditEventRepository()),
      turnRuntime: buildChatTurnRuntime({
        chatGateway: scriptedModel,
        fallbackReplyComposer: new MissingFallbackReplyComposer(),
        skillOutcomeCapabilities: { supportsGroundedAnswer: () => true },
        metrics,
      }),
      agentService: {
        resolve: async () => ({ ...legacyAgentWithoutWorkspace(workspace.id, new Date()), id: agentId, assistantDefaultLocale: "en" }),
      },
      agentRevisionRuntimeResolver: new AgentRevisionRuntimeResolver({
        findCurrentPublished: async () => revision,
        findRevision: async ({ revisionId: requested }) => requested === revisionId ? revision : null,
      }),
      turnRouter: { classify: async () => ({ route: "direct", framing: { isIdentityQuestion: false } }) },
      conversationEngine: createConversationEngine(),
      routineStore: new RoutineStateRepository(database.kysely, 60_000),
      routineProvider,
      assistantTurnPersistence: new PostgresAssistantTurnPersistence(
        database.kysely,
        new ConversationActivityRepository(database.kysely),
        60_000,
        undefined,
        undefined,
        undefined,
        undefined,
        createRoutineConsentTelemetry({ logger, metricsRegistry: metrics }),
      ),
    });

    const send = async (query: string, inputMetadata?: UserMessageInputMetadata) =>
      chat.answer({ workspaceId: workspace.id, agentId, conversationId, query, stream: false, ...(inputMetadata ? { inputMetadata } : {}) });
    // What the chat shows after a page reload: the conversation as its history reads it.
    const reloaded = async () => (await new ChatHistoryService(
      new ConversationRepository(database.kysely),
      new MessageRepository(database.kysely),
      new AuditEventRepository(database.kysely),
      new HistoryItemsRepository(database.kysely),
    ).getConversation(workspace.id, conversationId)).messages;
    const records = () => database.query<{
      decision: string;
      method: string;
      defaulted: boolean;
      channel: string | null;
      visitor_id: string | null;
      agent_id: string | null;
      slot_keys: string[];
      wording_version_id: string;
      locale: string;
      decision_message_id: string | null;
    }>(
      `SELECT decision, method, defaulted, channel, visitor_id, agent_id, slot_keys, wording_version_id, locale, decision_message_id
         FROM routine_consent_records WHERE conversation_id = $1 ORDER BY decided_at`,
      [conversationId],
    );
    const routineState = async () => (await database.query<{ status: string; variables: Record<string, unknown> }>(
      "SELECT status, variables FROM routine_states WHERE session_id = $1",
      [conversationId],
    ))[0] ?? null;
    const messages = () => database.query<{ id: string; role: string; content: string; metadata_json: Record<string, unknown> | null }>(
      "SELECT id, role, content, metadata_json FROM messages WHERE conversation_id = $1 ORDER BY created_at, id",
      [conversationId],
    );
    return { send, reloaded, records, routineState, messages, conversationId, agentId, visitorId: visitor.id, workspaceId: workspace.id };
  };

  const versionId = routineConsentWordingVersionId(wording);

  it("shows the wording verbatim with its two choices, then collects the field only after a typed grant", async () => {
    const conversation = await startConversation();
    await conversation.send("I want to book a class");

    const asked = await conversation.send("My name is Ada");
    expect(asked.answer).toBe(wording.body);
    expect(asked.suggestions).toEqual([
      { id: "agree", text: "I agree", kind: "authored", action: { kind: "ask_followup" } },
      { id: "decline", text: "No thanks", kind: "authored", action: { kind: "ask_followup" } },
    ]);
    const shownReply = (await conversation.messages()).at(-1)!;
    expect(shownReply.metadata_json?.consentPrompt).toEqual({ routineId: ROUTINE_ID, consentKey: "health", wordingVersionId: versionId, locale: "en" });
    expect(await conversation.records()).toEqual([]);

    const granted = await conversation.send("Yes, and I have a sore knee");
    const grantMessage = (await conversation.messages()).filter((message) => message.role === "user").at(-1)!;
    expect(await conversation.records()).toEqual([{
      decision: "granted",
      method: "reply",
      defaulted: false,
      channel: "website_embed",
      visitor_id: conversation.visitorId,
      agent_id: conversation.agentId,
      slot_keys: ["injury"],
      wording_version_id: versionId,
      locale: "en",
      decision_message_id: grantMessage.id,
    }]);
    // The message that grants consent fills no covered field; the step asks for it next.
    expect(granted.answer).toContain("[step reply to:");
    expect((await conversation.routineState())?.variables).toEqual({ name: "Ada" });
    // It may state the value all the same, so it reads as withheld wherever the transcript goes.
    expect(grantMessage.metadata_json?.sensitiveSlotKeys).toEqual(["injury"]);

    await conversation.send("I have a sore knee");
    expect((await conversation.routineState())?.variables).toMatchObject({ name: "Ada", injury: "sore knee" });
    expect(logged).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "routine_consent_shown", conversationId: conversation.conversationId, consentKey: "health", reask: false }),
      expect.objectContaining({ event: "routine_consent_decided", conversationId: conversation.conversationId, decision: "granted", method: "reply" }),
    ]));
  });

  it("records a click on the agree button as a button decision on the wording that prompt showed, whatever the label says", async () => {
    const conversation = await startConversation();
    await conversation.send("I want to book a class");
    await conversation.send("My name is Ada");
    const shownReply = (await conversation.messages()).at(-1)!;

    // After a reload the chat still offers the two choices with the wording.
    const restored = (await conversation.reloaded()).find((message) => message.id === shownReply.id);
    expect(restored?.suggestions).toEqual([
      expect.objectContaining({ id: "agree", text: "I agree" }),
      expect.objectContaining({ id: "decline", text: "No thanks" }),
    ]);

    // The scripted model would read this text as a decline; the chip id decides.
    await conversation.send("No", { method: "suggestion_click", suggestionSourceMessageId: shownReply.id, suggestionId: "agree" });

    expect((await conversation.records()).map(({ decision, method, wording_version_id }) => ({ decision, method, wording_version_id })))
      .toEqual([{ decision: "granted", method: "button", wording_version_id: versionId }]);
    await conversation.send("I have a sore knee");
    expect((await conversation.routineState())?.variables).toMatchObject({ name: "Ada", injury: "sore knee" });
  });

  it("reads a click on a prompt the conversation no longer shows last as a typed reply", async () => {
    const conversation = await startConversation({ sourceChannel: "email" });
    await conversation.send("I want to book a class");
    await conversation.send("My name is Ada");
    const firstPrompt = (await conversation.messages()).at(-1)!;
    await conversation.send("What do you do with it?");

    await conversation.send("No", { method: "suggestion_click", suggestionSourceMessageId: firstPrompt.id, suggestionId: "agree" });

    expect((await conversation.records()).map(({ decision, method }) => ({ decision, method }))).toEqual([{ decision: "declined", method: "reply" }]);
  });

  it("runs on without the field when a visitor declines a consent that continues", async () => {
    const conversation = await startConversation({ onDecline: "continue" });
    await conversation.send("I want to book a class");
    await conversation.send("My name is Ada");

    await conversation.send("No");

    expect((await conversation.records()).map(({ decision, defaulted }) => ({ decision, defaulted }))).toEqual([{ decision: "declined", defaulted: false }]);
    const state = await conversation.routineState();
    expect(state?.status).toBe("completed");
    expect(state?.variables).toEqual({ name: "Ada" });
  });

  it("hands the conversation to a person when a visitor declines a consent that hands off", async () => {
    const conversation = await startConversation({ onDecline: "handoff" });
    await conversation.send("I want to book a class");
    await conversation.send("My name is Ada");

    await conversation.send("No");

    expect((await conversation.records()).map(({ decision }) => decision)).toEqual(["declined"]);
    const ownership = await database.query<{ state: string; reason: string | null }>(
      "SELECT state, reason FROM conversation_ownership WHERE conversation_id = $1",
      [conversation.conversationId],
    );
    expect(ownership).toEqual([{ state: "human_owned", reason: "routine_consent_declined" }]);
  });

  it("answers an unclear reply from the wording and asks again, then records a decline after a second unclear reply", async () => {
    const conversation = await startConversation({ sourceChannel: "email" });
    await conversation.send("I want to book a class");
    const asked = await conversation.send("My name is Ada");
    expect(asked.answer).toBe(`${wording.body}\n\n${wording.agreeLabel}\n\n${wording.declineLabel}`);

    const askedAgain = await conversation.send("What do you do with it?");
    expect(askedAgain.answer).toBe(`${UNCLEAR_ANSWER}\n\n${wording.body}\n\n${wording.agreeLabel}\n\n${wording.declineLabel}`);
    expect(await conversation.records()).toEqual([]);

    await conversation.send("Maybe later");
    expect((await conversation.records()).map(({ decision, defaulted, channel }) => ({ decision, defaulted, channel })))
      .toEqual([{ decision: "declined", defaulted: true, channel: "email" }]);
    expect(logged).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "routine_consent_shown", conversationId: conversation.conversationId, reask: true }),
      expect.objectContaining({ event: "routine_consent_defaulted", conversationId: conversation.conversationId }),
    ]));
  });

  it("asks nothing and records nothing on a voice call, and the routine takes the decline path", async () => {
    const conversation = await startConversation({ sourceChannel: "voice" });
    await conversation.send("I want to book a class");

    const reply = await conversation.send("My name is Ada");

    expect(reply.answer).not.toBe(wording.body);
    expect(await conversation.records()).toEqual([]);
    expect((await conversation.messages()).some((message) => message.metadata_json?.consentPrompt)).toBe(false);
    expect(await conversation.routineState()).toMatchObject({ status: "completed", variables: { name: "Ada" } });
    expect(logged).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "routine_consent_skipped", conversationId: conversation.conversationId, reason: "channel" }),
    ]));
  });
});
