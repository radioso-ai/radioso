import { randomUUID } from "node:crypto";

import type { ChatStreamEvent, ReplyInterruptionMarker } from "../../modules/chat/contracts/index.js";
import {
  VoiceSessionRepository,
  VoiceSessionStartService,
  VoiceTurnService,
  createElevenLabsSessionStarter,
  type VoiceChatTurnRequest,
  type VoiceSessionStartPort,
  type VoiceTurnNotes,
  type VoiceTurnPort,
} from "../../modules/voiceChannel/public.js";
import type { AgentRecord } from "../../modules/agents/public.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import { isHumanOwned, type ConversationOwnershipReader } from "../../modules/handoff/public.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { VoiceVendor } from "../../shared/domain/voiceVendor.js";

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
 * The voice channel's turn port: sessions over Postgres, the same streaming chat turn the REST
 * agent channel runs, the agent's voice settings and the conversation's routine state and owner for
 * the turn policy, and notes on a previous turn's stored reply. Vendor adapters mount over this
 * port in the HTTP layer.
 */
export const createVoiceChannelComposition = (deps: {
  db: Db;
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
    sessions: new VoiceSessionRepository(deps.db),
    chat: { streamTurn: (request) => deps.assistantChatService.streamAnswer({ ...request, stream: true }) },
    agents: voiceProfileSource(deps.agentRepository),
    // A conversation's routine state is keyed by the conversation id.
    routines: { isRoutineActive: async (conversationId) => (await deps.routineStates.loadActive({ sessionId: conversationId })) !== null },
    ownership: { isHumanOwned: async (conversationId) => isHumanOwned(await deps.conversationOwnership.load(conversationId)) },
    notes: createVoiceTurnNotes({ replies: deps.replies, auditService: deps.auditService, logger: deps.logger }),
    metrics: deps.metricsRegistry,
    logger: deps.logger,
  });

/**
 * Starts voice sessions on the vendor agent each Radioso agent is bound to: the ElevenLabs session
 * starter over `fetch`, and the workspace's vendor key from the workspace credential store. A
 * vendor key is always the workspace's own; there is no deployment fallback, so a workspace without
 * one gets no session.
 */
export const createVoiceSessionStartComposition = (deps: {
  agentRepository: AgentVoiceProfileRepository;
  credentials: { getApiKey(workspaceId: string, provider: VoiceVendor): Promise<string | undefined> };
  fetch: typeof globalThis.fetch;
  metricsRegistry: MetricsRegistry | null;
  logger: AppLogger;
}): VoiceSessionStartPort =>
  new VoiceSessionStartService({
    agents: voiceProfileSource(deps.agentRepository),
    credentials: {
      read: async ({ workspaceId, vendor }) => {
        const apiKey = await deps.credentials.getApiKey(workspaceId, vendor);
        return apiKey ? { apiKey } : null;
      },
    },
    starters: { elevenlabs: createElevenLabsSessionStarter({ fetch: deps.fetch }) },
    newSessionKey: randomUUID,
    metrics: deps.metricsRegistry,
    logger: deps.logger,
  });
