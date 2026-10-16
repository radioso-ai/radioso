import { randomUUID } from "node:crypto";

import type { ChatStreamEvent, ReplyInterruptionMarker } from "../../modules/chat/contracts/index.js";
import {
  VoiceSessionStartService,
  VoiceTurnService,
  createElevenLabsSessionStarter,
  type VoiceChatTurnRequest,
  type VoiceSessionAvailabilityPort,
  type VoiceSessionStartLookup,
  type VoiceSessionStartPort,
  type VoiceSessionStartRegistry,
  type VoiceSessionStore,
  type VoiceTurnNotes,
  type VoiceTurnPort,
} from "../../modules/voiceChannel/public.js";
import type { AgentRecord } from "../../modules/agents/public.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import { isHumanOwned, type ConversationOwnershipReader } from "../../modules/handoff/public.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { VoiceVendor } from "../../shared/domain/voiceVendor.js";
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
 * Notes on a previous turn's stored reply. An interrupted reply is marked on the message first and
 * audited after, so a note that rejects is one the session writes again; the mark is idempotent. A
 * reply the conversation no longer holds is not marked and not audited, and the note resolves: a
 * retry would find it no more. Notes name the reply by id and count characters; they never carry
 * what was said.
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
    await deps.auditService.record({ workspaceId, eventType: "voice.reply_interrupted", eventStatus: "success", metadata });
  },
  replyReplayed: ({ workspaceId, ...metadata }) =>
    deps.auditService.record({ workspaceId, eventType: "voice.reply_replayed", eventStatus: "success", metadata }),
});

/**
 * The voice channel's turn port: sessions and their starts over one store (`VoiceSessionRepository`
 * in production, the same instance the session start records into), the same streaming chat turn the REST
 * agent channel runs, the agent's voice settings and the conversation's routine state and owner for
 * the turn policy, and notes on a previous turn's stored reply. Vendor adapters mount over this
 * port in the HTTP layer.
 */
export const createVoiceChannelComposition = (deps: {
  sessions: VoiceSessionStore & VoiceSessionStartLookup;
  assistantChatService: {
    streamAnswer(input: VoiceChatTurnRequest & { stream: true }): AsyncIterable<ChatStreamEvent>;
  };
  agentRepository: AgentVoiceProfileRepository;
  routineStates: { loadActive(input: { sessionId: string }): Promise<unknown> };
  conversationOwnership: ConversationOwnershipReader;
  replies: ReplyInterruptionMarker;
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
    notes: createVoiceTurnNotes({ replies: deps.replies, auditService: deps.auditService, logger: deps.logger }),
    metrics: deps.metricsRegistry,
    logger: deps.logger,
  });

/** A stored key the store cannot decrypt, as opposed to a store that cannot be read at all. */
const isUnreadableCredential = (error: unknown): boolean =>
  error instanceof ProviderConfigurationError
  && typeof error.details === "object" && error.details !== null
  && (error.details as { kind?: unknown }).kind === "credential_unreadable";

/**
 * Starts voice sessions on the vendor agent each Radioso agent is bound to: the ElevenLabs session
 * starter over `fetch`, the workspace's vendor key from the workspace credential store, and a
 * registry of started sessions (`VoiceSessionRepository` in production). A vendor key is always the workspace's own; there is no
 * deployment fallback, so a workspace without one gets no session. The same service tells a page
 * whether to offer sessions, from the key's presence alone (`hasCredentials` decrypts nothing).
 */
export const createVoiceSessionStartComposition = (deps: {
  agentRepository: AgentVoiceProfileRepository;
  starts: VoiceSessionStartRegistry;
  credentials: {
    getApiKey(workspaceId: string, provider: VoiceVendor): Promise<string | undefined>;
    hasCredentials(workspaceId: string, provider: VoiceVendor): Promise<boolean>;
  };
  fetch: typeof globalThis.fetch;
  metricsRegistry: MetricsRegistry | null;
  logger: AppLogger;
}): VoiceSessionStartPort & VoiceSessionAvailabilityPort =>
  new VoiceSessionStartService({
    agents: voiceProfileSource(deps.agentRepository),
    credentials: {
      read: async ({ workspaceId, vendor }) => {
        try {
          const apiKey = await deps.credentials.getApiKey(workspaceId, vendor);
          return apiKey ? { kind: "present", credential: { apiKey } } : { kind: "missing" };
        } catch (error) {
          if (isUnreadableCredential(error)) return { kind: "unreadable" };
          throw error;
        }
      },
      isStored: ({ workspaceId, vendor }) => deps.credentials.hasCredentials(workspaceId, vendor),
    },
    starters: { elevenlabs: createElevenLabsSessionStarter({ fetch: deps.fetch }) },
    starts: deps.starts,
    newSessionKey: randomUUID,
    metrics: deps.metricsRegistry,
    logger: deps.logger,
  });
