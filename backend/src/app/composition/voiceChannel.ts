import type { ChatStreamEvent, ReplyInterruptionMarker } from "../../modules/chat/contracts/index.js";
import {
  VoiceSessionRepository,
  VoiceTurnService,
  type VoiceChatTurnRequest,
  type VoiceTurnPort,
} from "../../modules/voiceChannel/public.js";
import type { AgentRecord } from "../../modules/agents/public.js";
import type { AuditPort } from "../../modules/audit/contracts/index.js";
import { isHumanOwned, type ConversationOwnershipReader } from "../../modules/handoff/public.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface VoiceTurnNoteSinks {
  replies: ReplyInterruptionMarker;
  auditService: Pick<AuditPort, "record">;
}

/**
 * Notes on a previous turn's stored reply. An interrupted reply is marked on the message first and
 * audited after, so a note that rejects is one the session writes again; the mark is idempotent.
 * Notes name the reply by id and count characters; they never carry what was said.
 */
export const createVoiceTurnNotes = (deps: VoiceTurnNoteSinks) => ({
  replyInterrupted: async (note: {
    workspaceId: string;
    conversationId: string;
    assistantMessageId: string;
    heardCharacterCount: number;
    spokenCharacterCount: number;
  }): Promise<void> => {
    const { workspaceId, ...metadata } = note;
    await deps.replies.markReplyInterrupted({
      workspaceId,
      conversationId: note.conversationId,
      messageId: note.assistantMessageId,
      heardCharacterCount: note.heardCharacterCount,
      spokenCharacterCount: note.spokenCharacterCount,
    });
    await deps.auditService.record({ workspaceId, eventType: "voice.reply_interrupted", eventStatus: "success", metadata });
  },
  replyReplayed: ({ workspaceId, ...metadata }: { workspaceId: string; conversationId: string; assistantMessageId: string }): Promise<void> =>
    deps.auditService.record({ workspaceId, eventType: "voice.reply_replayed", eventStatus: "success", metadata }),
});

/**
 * The voice channel's turn port: sessions over Postgres, the same streaming chat turn the REST
 * agent channel runs, the agent's voice settings and the conversation's routine state and owner for
 * the turn policy, and notes on a previous turn's stored reply. Vendor adapters mount over this
 * port in the HTTP layer.
 */
export const createVoiceChannelComposition = (deps: VoiceTurnNoteSinks & {
  db: Db;
  assistantChatService: {
    streamAnswer(input: VoiceChatTurnRequest & { stream: true }): AsyncIterable<ChatStreamEvent>;
  };
  agentRepository: {
    findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<Pick<AgentRecord, "voice" | "assistantDefaultLocale"> | null>;
  };
  routineStates: { loadActive(input: { sessionId: string }): Promise<unknown> };
  conversationOwnership: ConversationOwnershipReader;
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
    notes: createVoiceTurnNotes(deps),
    metrics: deps.metricsRegistry,
    logger: deps.logger,
  });
