import { randomUUID } from "node:crypto";

import type {
  ChatStreamEvent,
  OperatorReplySpeechClaims,
  ReplyInterruptionMarker,
  VoiceTurnFactsRecorder,
} from "../../modules/chat/contracts/index.js";
import {
  VoiceRecordingErasureDrain,
  VoiceRecordingErasureService,
  VoiceRecordingService,
  VoiceSessionStartService,
  VoiceTurnService,
  createElevenLabsRecordingSource,
  createElevenLabsSessionStarter,
  voiceRecordingErasureJobHandler,
  voiceRecordingErasureRequest,
  type VoiceChatTurnRequest,
  type VoiceRecordingAudit,
  type VoiceRecordingErasureBacklog,
  type VoiceRecordingStore,
  type VoiceVendorCredentialReader,
  type VoiceVendorCredentialSealer,
  type VoiceSessionAvailabilityPort,
  type VoiceSessionStartLookup,
  type VoiceSessionStartPort,
  type VoiceSessionStartRegistry,
  type VoiceSessionStore,
  type VoiceStoredReplyReader,
  type VoiceTurnNotes,
  type VoiceTurnPort,
  VOICE_REPLY_INTERRUPTED_EVENT,
} from "../../modules/voiceChannel/public.js";
import type { AgentRecord } from "../../modules/agents/public.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import type { BackgroundJobHandlerRegistration, BackgroundJobQueue } from "../../shared/background-jobs/index.js";
import { isHumanOwned, type ConversationOwnershipReader } from "../../modules/handoff/public.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import { isHumanAuthoredMessageSource } from "../../shared/domain/messageAuthorship.js";
import { isVoiceVendor, type VoiceVendor } from "../../shared/domain/voiceVendor.js";
import { ProviderConfigurationError } from "../../shared/infra/llm/providerTypes.js";

type AgentVoiceProfileRepository = {
  findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<Pick<AgentRecord, "voice" | "assistantDefaultLocale"> | null>;
};

/** The agent's voice block and default language, which both the turn and the session start read. */
const voiceProfileSource = (agentRepository: AgentVoiceProfileRepository) => ({
  findVoiceProfile: async ({ workspaceId, agentId }: { workspaceId: string; agentId: string }) => {
    const agent = await agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
    return agent ? { voice: agent.voice, defaultLocale: agent.assistantDefaultLocale } : null;
  },
});

/**
 * Notes on a turn's stored replies. An interrupted reply is marked on the message first and
 * audited after, so a note that rejects is one the session writes again; the mark is idempotent. A
 * reply the conversation no longer holds is not marked and not audited, and the note resolves: a
 * retry would find it no more. (The heard part of a reply cut off mid-stream is stored marked,
 * with its audit event, by chat.) A teammate's replies the turn recorded as spoken are audited (the
 * turn marks them through chat's claims port first). A finished turn's facts are kept on the reply
 * it stored, with no audit event; a reply the conversation no longer holds keeps none, and the
 * note resolves. Notes name replies by id and carry counts, timings and closed values; they never
 * carry what was said.
 */
export const createVoiceTurnNotes = (deps: {
  replies: ReplyInterruptionMarker & VoiceTurnFactsRecorder;
  auditService: Pick<AuditPort, "record">;
  logger: Pick<AppLogger, "warn">;
}): VoiceTurnNotes => ({
  replyInterrupted: async (note) => {
    const { workspaceId, ...metadata } = note;
    const { assistantMessageId, ...reply } = note;
    const marked = await deps.replies.markReplyInterrupted({ ...reply, messageId: assistantMessageId });
    if (!marked) {
      deps.logger.warn(
        { workspaceId, conversationId: note.conversationId, messageId: assistantMessageId },
        "Voice reply to mark interrupted was not found",
      );
      return;
    }
    // The same shape as the record of a reply cut off mid-stream, which chat writes with `partial: true`.
    await deps.auditService.record({ workspaceId, eventType: VOICE_REPLY_INTERRUPTED_EVENT, eventStatus: "success", metadata: { ...metadata, partial: false } });
  },
  replyReplayed: ({ workspaceId, ...metadata }) =>
    deps.auditService.record({ workspaceId, eventType: "voice.reply_replayed", eventStatus: "success", metadata }),
  operatorRepliesSpoken: ({ workspaceId, ...metadata }) =>
    deps.auditService.record({ workspaceId, eventType: "voice.operator_reply_spoken", eventStatus: "success", metadata }),
  turnFacts: async ({ workspaceId, conversationId, assistantMessageId, facts }) => {
    const kept = await deps.replies.recordVoiceTurnFacts({ workspaceId, conversationId, messageId: assistantMessageId, ...facts });
    if (!kept) {
      deps.logger.warn(
        { workspaceId, conversationId, messageId: assistantMessageId },
        "Voice reply to keep the turn's facts on was not found",
      );
    }
  },
});

/**
 * The voice channel's turn port: sessions and their starts over one store (`VoiceSessionRepository`
 * in production, the same instance the session start records into), the same streaming chat turn the REST
 * agent channel runs, the agent's voice settings and the conversation's routine state and owner for
 * the turn policy, the teammate replies the caller has not heard, and notes on a turn's stored
 * replies. The message repository is chat's side of the replies: it reads a teammate's pending
 * replies, marks them spoken, marks an interrupted one, and keeps each turn's facts. Vendor adapters mount over this port
 * in the HTTP layer.
 */
/** The conversation's newest messages of the roles asked for, as the message store lists them, oldest first. */
interface RecentMessages {
  listRecentByConversationId(
    workspaceId: string,
    conversationId: string,
    limit: number,
    options?: { roles?: readonly ("user" | "assistant" | "system")[] },
  ): Promise<ReadonlyArray<{ id: string; role: string; content: string; source?: string; createdAt: Date }>>;
}

/**
 * How many of the conversation's newest assistant messages are searched for the agent's answer:
 * teammate replies written in the seconds after the caller's message sit among them.
 */
const STORED_REPLY_SEARCH_LIMIT = 20;

/**
 * The conversation's newest user message, read on its own, and the agent's reply to it: the
 * first assistant message after it with words written by the agent (a teammate's reply is spoken
 * through its own claims), however many teammate replies came in between.
 */
export const createVoiceStoredReplyReader = (messages: RecentMessages): VoiceStoredReplyReader => ({
  newestExchange: async ({ workspaceId, conversationId }) => {
    const [utterance] = (await messages.listRecentByConversationId(workspaceId, conversationId, 1, { roles: ["user"] }))
      .filter((message) => message.role === "user");
    if (!utterance) {
      return null;
    }
    const reply = (await messages.listRecentByConversationId(workspaceId, conversationId, STORED_REPLY_SEARCH_LIMIT, { roles: ["assistant"] }))
      .find((message) =>
        message.role === "assistant"
        && message.createdAt.getTime() >= utterance.createdAt.getTime()
        && !isHumanAuthoredMessageSource(message.source)
        && message.content.trim().length > 0);
    return { utterance: utterance.content, reply: reply ? { messageId: reply.id, text: reply.content } : null };
  },
});

export const createVoiceChannelComposition = (deps: {
  sessions: VoiceSessionStore & VoiceSessionStartLookup;
  assistantChatService: {
    streamAnswer(input: VoiceChatTurnRequest & { stream: true }): AsyncIterable<ChatStreamEvent>;
  };
  agentRepository: AgentVoiceProfileRepository;
  routineStates: { loadActive(input: { sessionId: string }): Promise<unknown> };
  conversationOwnership: ConversationOwnershipReader;
  replies: ReplyInterruptionMarker & VoiceTurnFactsRecorder & OperatorReplySpeechClaims & RecentMessages;
  auditService: Pick<AuditPort, "record">;
  metricsRegistry: MetricsRegistry | null;
  logger: AppLogger;
  /** Overrides `VOICE_BEHAVIOR`'s turn timing; tests only. */
  timing?: ConstructorParameters<typeof VoiceTurnService>[0]["timing"];
}): VoiceTurnPort =>
  new VoiceTurnService({
    sessions: deps.sessions,
    starts: deps.sessions,
    chat: { streamTurn: (request) => deps.assistantChatService.streamAnswer({ ...request, stream: true }) },
    agents: voiceProfileSource(deps.agentRepository),
    // A conversation's routine state is keyed by the conversation id.
    routines: { isRoutineActive: async (conversationId) => (await deps.routineStates.loadActive({ sessionId: conversationId })) !== null },
    ownership: { isHumanOwned: async (conversationId) => isHumanOwned(await deps.conversationOwnership.load(conversationId)) },
    operatorReplies: { claims: deps.replies, newClaimTurnId: randomUUID },
    storedReplies: createVoiceStoredReplyReader(deps.replies),
    notes: createVoiceTurnNotes({ replies: deps.replies, auditService: deps.auditService, logger: deps.logger }),
    metrics: deps.metricsRegistry,
    logger: deps.logger,
    ...(deps.timing ? { timing: deps.timing } : {}),
  });

/** A stored key the store cannot decrypt, as opposed to a store that cannot be read at all. */
const isUnreadableCredential = (error: unknown): boolean =>
  error instanceof ProviderConfigurationError
  && typeof error.details === "object" && error.details !== null
  && (error.details as { kind?: unknown }).kind === "credential_unreadable";

/** The workspace credential store's reads of a voice vendor's key. */
type VoiceVendorCredentialStore = {
  getApiKey(workspaceId: string, provider: VoiceVendor): Promise<string | undefined>;
  hasCredentials(workspaceId: string, provider: VoiceVendor): Promise<boolean>;
  isEncryptionConfigured(): boolean;
};

/** The workspace credential store's own encryption, for a key held where the store's rows cannot outlive it. */
type CredentialSealing = {
  sealSecret(plaintext: string): string;
  openSealedSecret(sealed: string): string;
};

/** A voice vendor's key sealed for the recording erasure backlog the way the credential store seals its own. */
const voiceVendorCredentialSealer = (store: CredentialSealing): VoiceVendorCredentialSealer => ({
  seal: ({ apiKey }) => store.sealSecret(apiKey),
  open: (sealed) => ({ apiKey: store.openSealedSecret(sealed) }),
});

/**
 * A vendor's key as the voice channel reads it from the workspace credential store: decrypted only
 * by `read`, inside the request that needs it, and `presence` from the stored row and the
 * backend's master key alone.
 */
const voiceVendorCredentialReader = (credentials: VoiceVendorCredentialStore): VoiceVendorCredentialReader => ({
  read: async ({ workspaceId, vendor }) => {
    try {
      const apiKey = await credentials.getApiKey(workspaceId, vendor);
      return apiKey ? { kind: "present", credential: { apiKey } } : { kind: "missing" };
    } catch (error) {
      if (isUnreadableCredential(error)) return { kind: "unreadable" };
      throw error;
    }
  },
  presence: async ({ workspaceId, vendor }) => {
    if (!await credentials.hasCredentials(workspaceId, vendor)) return "missing";
    return credentials.isEncryptionConfigured() ? "stored" : "unreadable";
  },
});

/** A row may only point at a workspace or an organization that still exists; one gone since is kept by id in the metadata. */
const deletionSubject = (event: { account: { id: string; deleted: boolean }; workspaceId: string; workspaceDeleted: boolean }) => ({
  row: {
    accountId: event.account.deleted ? null : event.account.id,
    workspaceId: event.workspaceDeleted ? null : event.workspaceId,
  },
  metadata: {
    ...(event.workspaceDeleted ? { deletedWorkspaceId: event.workspaceId } : {}),
    ...(event.account.deleted ? { deletedAccountId: event.account.id } : {}),
  },
});

/**
 * The audit events a recording leaves, ids and closed codes only: who played which conversation's
 * recording, and how each deletion at the vendor ended, with the organization it belonged to. A
 * recording given up on is the same event as a failure, with why and the vendor's id for it, so
 * the organization can delete it there.
 */
const createVoiceRecordingAudit = (auditService: Pick<AuditPort, "record">): VoiceRecordingAudit => ({
  played: ({ workspaceId, ...metadata }) =>
    auditService.record({ workspaceId, eventType: "conversation.recording_played", eventStatus: "success", metadata }),
  deleted: (event) => {
    const subject = deletionSubject(event);
    return auditService.record({
      ...subject.row,
      eventType: "conversation.recording_deleted",
      eventStatus: "success",
      metadata: { conversationId: event.conversationId, vendor: event.vendor, outcome: event.outcome, ...subject.metadata },
    });
  },
  left: (event) => {
    const subject = deletionSubject(event);
    return auditService.record({
      ...subject.row,
      eventType: "conversation.recording_deleted",
      eventStatus: "failure",
      metadata: {
        conversationId: event.conversationId,
        vendor: event.vendor,
        outcome: "left_at_vendor",
        reason: event.reason,
        vendorConversationId: event.vendorConversationId,
        ...subject.metadata,
      },
    });
  },
});

/**
 * Voice recordings, kept by the vendor: the ElevenLabs recording source over `fetch`, the
 * workspace's vendor key from the workspace credential store, `voice_sessions` for where each
 * recording lives (`VoiceSessionRepository` in production, the same store the session start
 * records into), and the audit service for each play and each deletion. A deletion hands its
 * recordings, and the key sealed by the credential store's own encryption, to the erasure backlog
 * in its own transaction (`erasureIn`), with the erasure job queued beside them; the job's handler
 * deletes them at the vendor through the same source and audit.
 */
export const createVoiceRecordingComposition = (deps: {
  recordings: VoiceRecordingStore;
  /** The same store over another handle: a deletion's transaction. */
  recordingsIn: (db: Db) => VoiceRecordingStore;
  erasures: VoiceRecordingErasureBacklog;
  /** The same backlog over another handle: a deletion's transaction, or a dead letter's. */
  erasuresIn: (db: Db) => VoiceRecordingErasureBacklog;
  credentials: VoiceVendorCredentialStore & CredentialSealing;
  fetch: typeof globalThis.fetch;
  auditService: Pick<AuditPort, "record">;
  queue: Pick<BackgroundJobQueue, "enqueue" | "enqueueInTransaction" | "wake">;
  metricsRegistry: MetricsRegistry | null;
  logger: AppLogger;
}): {
  recordings: VoiceRecordingService;
  /** The hand-off of a deletion's recordings, reading and writing in the deletion's transaction. */
  erasureIn: (db: Db) => VoiceRecordingErasureService;
  /** Deletes handed-off recordings at the vendor, on the background-job runtime. */
  erasureJobHandler: BackgroundJobHandlerRegistration;
} => {
  const credentials = voiceVendorCredentialReader(deps.credentials);
  const sealer = voiceVendorCredentialSealer(deps.credentials);
  const sources = { elevenlabs: createElevenLabsRecordingSource({ fetch: deps.fetch }) };
  const audit = createVoiceRecordingAudit(deps.auditService);
  const drain = new VoiceRecordingErasureDrain({
    backlog: deps.erasures,
    backlogIn: deps.erasuresIn,
    sealer,
    sources,
    audit,
    queue: deps.queue,
    metrics: deps.metricsRegistry,
    logger: deps.logger,
  });
  return {
    recordings: new VoiceRecordingService({
      recordings: deps.recordings,
      credentials,
      sources,
      audit,
      metrics: deps.metricsRegistry,
      logger: deps.logger,
    }),
    erasureIn: (db) => new VoiceRecordingErasureService({
      recordings: deps.recordingsIn(db),
      backlog: deps.erasuresIn(db),
      credentials,
      sealer,
      jobs: {
        queue: async (erasureId) => {
          await deps.queue.enqueueInTransaction(db, voiceRecordingErasureRequest(erasureId));
        },
        wake: () => deps.queue.wake(),
      },
      logger: deps.logger,
    }),
    erasureJobHandler: voiceRecordingErasureJobHandler(drain),
  };
};

/**
 * The embed config says whether the embed offers calls, which follows the voice vendor key's
 * presence, and a CDN may hold it for minutes: storing or removing a voice vendor key drops the
 * workspace's cached embed configs, so the Talk button follows at once. Model provider keys leave
 * them alone.
 */
export const refreshEmbedConfigsOnVoiceVendorKeyChange = (deps: {
  credentials: { onChange(listener: (change: { workspaceId: string; provider: string }) => Promise<void>): void };
  embedConfigs: { invalidateEmbedConfigs(workspaceId: string): Promise<void> };
}): void => {
  deps.credentials.onChange(async ({ workspaceId, provider }) => {
    if (isVoiceVendor(provider)) await deps.embedConfigs.invalidateEmbedConfigs(workspaceId);
  });
};

/**
 * Starts voice sessions on the vendor agent each Radioso agent is bound to: the ElevenLabs session
 * starter over `fetch`, the workspace's vendor key from the workspace credential store, and a
 * registry of started sessions (`VoiceSessionRepository` in production). A vendor key is always the workspace's own; there is no
 * deployment fallback, so a workspace without one gets no session. The same service tells a page
 * whether to offer sessions, from the key's presence alone (`hasCredentials` decrypts nothing) and
 * whether the backend holds the master key to read it.
 */
export const createVoiceSessionStartComposition = (deps: {
  agentRepository: AgentVoiceProfileRepository;
  starts: VoiceSessionStartRegistry;
  credentials: VoiceVendorCredentialStore;
  fetch: typeof globalThis.fetch;
  metricsRegistry: MetricsRegistry | null;
  logger: AppLogger;
}): VoiceSessionStartPort & VoiceSessionAvailabilityPort =>
  new VoiceSessionStartService({
    agents: voiceProfileSource(deps.agentRepository),
    credentials: voiceVendorCredentialReader(deps.credentials),
    starters: { elevenlabs: createElevenLabsSessionStarter({ fetch: deps.fetch }) },
    starts: deps.starts,
    newSessionKey: randomUUID,
    metrics: deps.metricsRegistry,
    logger: deps.logger,
  });
