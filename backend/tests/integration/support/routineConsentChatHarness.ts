import { randomUUID } from "node:crypto";

import { createConversationEngine } from "@radioso/conversation-engine";

import { createWorkspaceConversationDataErasure } from "../../../src/app/composition/conversationErasure.js";
import { composeRoutineTurnProvider } from "../../../src/app/composition/routineTurnProvider.js";
import { AccountRepository } from "../../../src/db/repositories/accountRepository.js";
import { AuditEventRepository } from "../../../src/db/repositories/auditEventRepository.js";
import { ConversationActivityRepository } from "../../../src/db/repositories/conversationActivityRepository.js";
import { ConversationRepository } from "../../../src/db/repositories/conversationRepository.js";
import { HistoryItemsRepository } from "../../../src/db/repositories/historyItemsRepository.js";
import { MessageRepository } from "../../../src/db/repositories/messageRepository.js";
import { PersonalCredentialLifecycleRepository } from "../../../src/db/repositories/personalCredentialLifecycleRepository.js";
import { RoutineStateRepository } from "../../../src/db/repositories/routineStateRepository.js";
import { WorkspaceRepository } from "../../../src/db/repositories/workspaceRepository.js";
import { AgentRevisionRuntimeResolver, type AgentRevision } from "../../../src/modules/agents/public.js";
import type { RoutineRegistration } from "../../../src/modules/chat/composition.js";
import { PostgresAssistantTurnPersistence } from "../../../src/modules/chat/infra/postgresAssistantTurnPersistence.js";
import { ChatHistoryService } from "../../../src/modules/chat/services/chatHistoryService.js";
import { ChatService, type ChatGateway } from "../../../src/modules/chat/services/chatService.js";
import { buildChatTurnRuntime } from "../../../src/modules/chat/services/chatTurnRuntime.js";
import { MissingFallbackReplyComposer } from "../../../src/modules/chat/services/fallbackReplyComposer.js";
import { legacyAgentWithoutWorkspace } from "../../../src/modules/chat/services/legacyWorkspaceAgent.js";
import { compileRoutineDefinition, createRoutineConsentTelemetry, type RoutineDefinition } from "../../../src/modules/routines/public.js";
import type { UserMessageInputMetadata } from "../../../src/shared/domain/chatInputMetadata.js";
import type { Database } from "../../../src/shared/infra/database.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";
import { createAuditService, InMemoryAuditEventRepository } from "../../support/fakes.js";

export const CONSENT_ROUTINE_ID = "routine-class-booking";

export const consentWording = {
  locale: "en",
  body: "We ask about injuries only to adapt your class. Your answer stays with this booking.",
  agreeLabel: "I agree",
  declineLabel: "No thanks",
};

/**
 * A class booking: a name, then an injury, a sensitive field the consent covers. `askTime` adds a
 * step after the injury, so the routine is still running once the injury is collected.
 */
export const classBooking = (onDecline: "continue" | "handoff", options: { askTime?: boolean } = {}): RoutineDefinition => ({
  id: CONSENT_ROUTINE_ID,
  agentId: "agent",
  lineageId: CONSENT_ROUTINE_ID,
  name: "Book a class",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "The visitor wants to book a class.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
  slots: [
    { stableSlotId: "slot_name", key: "name", type: "text", required: true, description: "The visitor's name", ordinal: 0 },
    { stableSlotId: "slot_injury", key: "injury", type: "text", required: true, description: "Any injury", ordinal: 1, sensitivity: "sensitive" },
    ...(options.askTime
      ? [{ stableSlotId: "slot_time", key: "time", type: "text" as const, required: true, description: "When the visitor wants to come", ordinal: 2 }]
      : []),
  ],
  steps: [
    { stableStepId: "ask_name", kind: "chat", instruction: "Ask for {{slot.name}}.", toolRef: null, ordinal: 0, metadata: {} },
    { stableStepId: "ask_injury", kind: "chat", instruction: "Ask about {{slot.injury}}.", toolRef: null, ordinal: 1, metadata: {} },
    ...(options.askTime
      ? [{ stableStepId: "ask_time", kind: "chat" as const, instruction: "Ask for {{slot.time}}.", toolRef: null, ordinal: 2, metadata: {} }]
      : []),
  ],
  transitions: [
    { fromStep: "ask_name", toRef: "ask_injury", guardKind: "default", guardText: null, ordinal: 0 },
    { fromStep: "ask_injury", toRef: options.askTime ? "ask_time" : "done", guardKind: "default", guardText: null, ordinal: 1 },
    ...(options.askTime ? [{ fromStep: "ask_time", toRef: "done", guardKind: "default" as const, guardText: null, ordinal: 2 }] : []),
  ],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm the booking.", ordinal: 0 }],
  consents: [{ key: "health", slotKeys: ["injury"], variants: [consentWording], onDecline }],
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
});

/**
 * Chat turns through the production ChatService, routine provider and turn persistence, on a
 * scripted model, for one published agent per conversation that runs `definition`.
 */
export const createRoutineConsentChatHarness = (database: Database, model: ChatGateway) => {
  const seededAccountIds: string[] = [];
  const metrics = new MetricsRegistry();
  const logged: Array<Record<string, unknown>> = [];

  /** A workspace whose published agent runs `definition`, and one conversation with it on `sourceChannel`. */
  const startConversation = async (input: { definition: RoutineDefinition; sourceChannel?: string }) => {
    const { definition } = input;
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
          loadPinned: async ({ routineIds }: { routineIds: string[] }) => routineIds.includes(definition.id) ? [registration] : [],
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
      chatGateway: model,
      auditService: createAuditService(new InMemoryAuditEventRepository()),
      turnRuntime: buildChatTurnRuntime({
        chatGateway: model,
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
      id: string;
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
      `SELECT id, decision, method, defaulted, channel, visitor_id, agent_id, slot_keys, wording_version_id, locale, decision_message_id
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
    return {
      send,
      reloaded,
      records,
      routineState,
      messages,
      conversationId,
      agentId,
      visitorId: visitor.id,
      workspaceId: workspace.id,
      accountId: account.id,
    };
  };

  /** Deletes every account the harness seeded, with its workspaces. */
  const cleanup = async () => {
    const lifecycle = new PersonalCredentialLifecycleRepository(database.kysely, createWorkspaceConversationDataErasure());
    for (const accountId of seededAccountIds) {
      await lifecycle.deleteAccount({
        accountId,
        auditEvent: { accountId, eventType: "account.delete", eventStatus: "success", metadata: {} },
      });
    }
  };

  return { startConversation, cleanup, logged, metrics };
};
