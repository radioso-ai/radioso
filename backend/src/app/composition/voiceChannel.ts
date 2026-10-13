import type { ChatStreamEvent } from "../../modules/chat/contracts/index.js";
import {
  VoiceSessionRepository,
  VoiceTurnService,
  type VoiceChatTurnRequest,
  type VoiceTurnPort,
} from "../../modules/voiceChannel/public.js";
import type { AgentRecord } from "../../modules/agents/public.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * The voice channel's turn port: sessions over Postgres, the same streaming chat turn the REST
 * agent channel runs, the agent's voice settings and routine state for the turn policy, and audit
 * notes on a previous turn's stored reply. Vendor adapters mount over this port in the HTTP layer.
 */
export const createVoiceChannelComposition = (deps: {
  db: Db;
  assistantChatService: {
    streamAnswer(input: VoiceChatTurnRequest & { stream: true }): AsyncIterable<ChatStreamEvent>;
  };
  agentRepository: {
    findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<Pick<AgentRecord, "voice" | "assistantDefaultLocale"> | null>;
  };
  routineStates: { loadActive(input: { sessionId: string }): Promise<unknown> };
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
