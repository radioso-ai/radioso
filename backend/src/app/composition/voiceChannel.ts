import type { ChatStreamEvent } from "../../modules/chat/contracts/index.js";
import {
  PostgresVoiceSessionMemoryStore,
  PostgresVoiceSessionNotices,
  VoiceSessionMemory,
  VoiceSessionRepository,
  VoiceTurnService,
  type VoiceChatTurnRequest,
  type VoiceTurnPort,
} from "../../modules/voiceChannel/public.js";
import type { AgentRecord } from "../../modules/agents/public.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import { isHumanOwned, type ConversationOwnershipReader } from "../../modules/handoff/public.js";
import { VOICE_BEHAVIOR } from "../../shared/domain/behaviorConfig.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { NotificationHandlers } from "../../shared/infra/postgresNotificationListener.js";

/**
 * The voice channel's turn port: sessions and their memory between requests over Postgres, with
 * the process's shared `LISTEN` connection telling an overtaken request on this instance that a
 * newer one arrived on another; the same streaming chat turn the REST agent channel runs; the
 * agent's voice settings and the conversation's routine state and owner for the turn policy; and
 * audit notes on a previous turn's stored reply. Vendor adapters mount over this port in the HTTP
 * layer.
 */
export const createVoiceChannelComposition = (deps: {
  db: Db;
  notificationListener: { subscribe(channel: string, handlers: NotificationHandlers): () => void };
  assistantChatService: {
    streamAnswer(input: VoiceChatTurnRequest & { stream: true }): AsyncIterable<ChatStreamEvent>;
  };
  agentRepository: {
    findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<Pick<AgentRecord, "voice" | "assistantDefaultLocale"> | null>;
  };
  routineStates: { loadActive(input: { sessionId: string }): Promise<unknown> };
  conversationOwnership: ConversationOwnershipReader;
  auditService: Pick<AuditPort, "record">;
  metricsRegistry: MetricsRegistry | null;
  logger: AppLogger;
}): VoiceTurnPort =>
  new VoiceTurnService({
    sessions: new VoiceSessionRepository(deps.db),
    chat: { streamTurn: (request) => deps.assistantChatService.streamAnswer({ ...request, stream: true }) },
    agents: {
      findVoiceProfile: async ({ workspaceId, agentId }) => {
        const agent = await deps.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
        return agent ? { voice: agent.voice, defaultLocale: agent.assistantDefaultLocale } : null;
      },
    },
    // A conversation's routine state is keyed by the conversation id.
    routines: { isRoutineActive: async (conversationId) => (await deps.routineStates.loadActive({ sessionId: conversationId })) !== null },
    ownership: { isHumanOwned: async (conversationId) => isHumanOwned(await deps.conversationOwnership.load(conversationId)) },
    memory: new VoiceSessionMemory({
      store: new PostgresVoiceSessionMemoryStore(deps.db),
      notices: new PostgresVoiceSessionNotices(deps.notificationListener, deps.logger),
      windows: { replayWindowMs: VOICE_BEHAVIOR.replayWindowMs, bridgeAfterMs: VOICE_BEHAVIOR.bridgeAfterMs },
      logger: deps.logger,
    }),
    // Notes name the reply by id and count characters; they never carry what was said.
    notes: {
      replyInterrupted: ({ workspaceId, ...metadata }) => deps.auditService.record({
        workspaceId,
        eventType: "voice.reply_interrupted",
        eventStatus: "success",
        metadata,
      }),
      replyReplayed: ({ workspaceId, ...metadata }) => deps.auditService.record({
        workspaceId,
        eventType: "voice.reply_replayed",
        eventStatus: "success",
        metadata,
      }),
    },
    metrics: deps.metricsRegistry,
    logger: deps.logger,
  });
