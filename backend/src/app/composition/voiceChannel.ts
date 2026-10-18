import { randomUUID } from "node:crypto";

import type {
  ChatStreamEvent,
  OperatorReplySpeechClaims,
  ReplyInterruptionMarker,
} from "../../modules/chat/contracts/index.js";
import {
  VoiceRecordingErasureService,
  VoiceRecordingService,
  VoiceSessionStartService,
  VoiceTurnService,
  createElevenLabsRecordingSource,
  createElevenLabsSessionStarter,
  type VoiceChatTurnRequest,
  type VoiceRecordingAudit,
  type VoiceRecordingStore,
  type VoiceVendorCredentialReader,
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
 * turn marks them through chat's claims port first). Notes name replies by id and count
 * characters; they never carry what was said.
 */
export const createVoiceTurnNotes = (deps: {
  replies: ReplyInterruptionMarker;
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
});

/**
 * The voice channel's turn port: sessions and their starts over one store (`VoiceSessionRepository`
 * in production, the same instance the session start records into), the same streaming chat turn the REST
 * agent channel runs, the agent's voice settings and the conversation's routine state and owner for
 * the turn policy, the teammate replies the caller has not heard, and notes on a turn's stored
 * replies. The message repository is chat's side of the replies: it reads a teammate's pending
 * replies, marks them spoken, and marks an interrupted one. Vendor adapters mount over this port
 * in the HTTP layer.
 */
/** The conversation's newest messages, as the message store lists them, oldest first. */
interface RecentMessages {
  listRecentByConversationId(
    workspaceId: string,
    conversationId: string,
    limit: number,
    options?: { roles?: readonly ("user" | "assistant" | "system")[] },
  ): Promise<ReadonlyArray<{ id: string; role: string; content: string; source?: string }>>;
}

/**
 * The conversation's newest user message and the agent's reply to it: an assistant message after
 * it with words, written by the agent (a teammate's reply is spoken through its own claims).
 */
export const createVoiceStoredReplyReader = (messages: RecentMessages): VoiceStoredReplyReader => ({
  newestExchange: async ({ workspaceId, conversationId }) => {
    const recent = (await messages.listRecentByConversationId(workspaceId, conversationId, 4, { roles: ["user", "assistant"] }))
      .filter((message) => message.role === "user" || message.role === "assistant");
    const userIndex = recent.map((message) => message.role).lastIndexOf("user");
    const utterance = recent[userIndex];
    if (!utterance) {
      return null;
    }
    const reply = recent.slice(userIndex + 1)
      .find((message) => !isHumanAuthoredMessageSource(message.source) && message.content.trim().length > 0);
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
  replies: ReplyInterruptionMarker & OperatorReplySpeechClaims & RecentMessages;
  auditService: Pick<AuditPort, "record">;
  metricsRegistry: MetricsRegistry | null;
  logger: AppLogger;
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

/**
 * The audit events a recording leaves, ids only: who played which conversation's recording, and
 * each recording deleted at the vendor, with the organization it belonged to.
 */
const createVoiceRecordingAudit = (auditService: Pick<AuditPort, "record">): VoiceRecordingAudit => ({
  played: ({ workspaceId, ...metadata }) =>
    auditService.record({ workspaceId, eventType: "conversation.recording_played", eventStatus: "success", metadata }),
  // A row may only point at a workspace or an organization that still exists; one deleted with the
  // recording is kept by id in the metadata, where the organization's records can still find it.
  deleted: ({ account, workspaceId, workspaceDeleted, conversationId, vendor, outcome }) =>
    auditService.record({
      accountId: account && !account.deleted ? account.id : null,
      workspaceId: workspaceDeleted ? null : workspaceId,
      eventType: "conversation.recording_deleted",
      eventStatus: "success",
      metadata: {
        conversationId,
        vendor,
        outcome,
        ...(workspaceDeleted ? { deletedWorkspaceId: workspaceId } : {}),
        ...(account?.deleted ? { deletedAccountId: account.id } : {}),
      },
    }),
});

/**
 * Voice recordings, kept by the vendor: the ElevenLabs recording source over `fetch`, the
 * workspace's vendor key from the workspace credential store, `voice_sessions` for where each
 * recording lives (`VoiceSessionRepository` in production, the same store the session start
 * records into), and the audit service for each play and each deletion. The same dependencies
 * serve the playback and the erasure that follows a deletion.
 */
export const createVoiceRecordingComposition = (deps: {
  recordings: VoiceRecordingStore;
  /** The same store over another handle: a conversation erasure's transaction. */
  recordingsIn: (db: Db) => VoiceRecordingStore;
  credentials: VoiceVendorCredentialStore;
  fetch: typeof globalThis.fetch;
  auditService: Pick<AuditPort, "record">;
  metricsRegistry: MetricsRegistry | null;
  logger: AppLogger;
}): {
  recordings: VoiceRecordingService;
  erasure: VoiceRecordingErasureService;
  /** The erasure reading and locking the recordings in a conversation erasure's transaction. */
  erasureIn: (db: Db) => VoiceRecordingErasureService;
} => {
  const dependencies = {
    recordings: deps.recordings,
    credentials: voiceVendorCredentialReader(deps.credentials),
    sources: { elevenlabs: createElevenLabsRecordingSource({ fetch: deps.fetch }) },
    audit: createVoiceRecordingAudit(deps.auditService),
    metrics: deps.metricsRegistry,
    logger: deps.logger,
  };
  return {
    recordings: new VoiceRecordingService(dependencies),
    erasure: new VoiceRecordingErasureService(dependencies),
    erasureIn: (db) => new VoiceRecordingErasureService({ ...dependencies, recordings: deps.recordingsIn(db) }),
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
