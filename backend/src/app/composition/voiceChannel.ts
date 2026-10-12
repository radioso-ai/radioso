import type { ChatStreamEvent } from "../../modules/chat/contracts/index.js";
import {
  VoiceSessionRepository,
  VoiceTurnService,
  type VoiceChatTurnRequest,
  type VoiceTurnPort,
} from "../../modules/voiceChannel/public.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * The voice channel's turn port: sessions over Postgres, and the same streaming chat turn the REST
 * agent channel runs. Vendor adapters mount over this port in the HTTP layer.
 */
export const createVoiceChannelComposition = (deps: {
  db: Db;
  assistantChatService: {
    streamAnswer(input: VoiceChatTurnRequest & { stream: true }): AsyncIterable<ChatStreamEvent>;
  };
  logger: AppLogger;
}): VoiceTurnPort =>
  new VoiceTurnService({
    sessions: new VoiceSessionRepository(deps.db),
    chat: { streamTurn: (request) => deps.assistantChatService.streamAnswer({ ...request, stream: true }) },
    logger: deps.logger,
  });
