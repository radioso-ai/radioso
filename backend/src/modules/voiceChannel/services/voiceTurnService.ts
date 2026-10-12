import type { ChatStreamEvent } from "../../chat/contracts/index.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { VOICE_SOURCE_CHANNEL } from "../../../shared/domain/conversationSource.js";
import type {
  VoiceChannelContext,
  VoiceSessionRef,
  VoiceTurnEvent,
  VoiceTurnInput,
  VoiceTurnPort,
} from "../domain.js";
import { splitCompleteSentences } from "./speechSegmenter.js";

/** Where a voice session's conversation is remembered. */
export interface VoiceSessionStore {
  findConversationId(session: VoiceSessionRef): Promise<string | null>;
  /** Binds the session unless it is bound already; returns the conversation it is bound to. */
  bind(session: VoiceSessionRef, conversationId: string): Promise<string>;
}

export interface VoiceChatTurnRequest {
  workspaceId: string;
  agentId: string;
  /** Absent on a session's first turn: the chat turn starts the conversation. */
  conversationId?: string;
  message: string;
  sourceChannel: typeof VOICE_SOURCE_CHANNEL;
  channelContext: VoiceChannelContext;
  signal: AbortSignal;
}

/** The streaming chat turn every other channel runs. */
interface VoiceChatPort {
  streamTurn(request: VoiceChatTurnRequest): AsyncIterable<ChatStreamEvent>;
}

interface VoiceTurnServiceDependencies {
  sessions: VoiceSessionStore;
  chat: VoiceChatPort;
  logger: Pick<AppLogger, "info" | "warn">;
  now?: () => number;
}

type VoiceTurnResult = "completed" | "superseded" | "abandoned" | "failed";

/** A session's first turn in this process, until it binds the session or ends without binding it. */
interface FirstTurn {
  settled: Promise<void>;
  settle(): void;
}

/** What a turn starts from: the session's conversation, or the claim to start one. */
type SessionClaim =
  | { conversationId: string }
  | { conversationId: null; firstTurn: FirstTurn };

const createFirstTurn = (): FirstTurn => {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  return { settled, settle };
};

const sessionKeyOf = (session: VoiceSessionRef): string =>
  JSON.stringify([session.workspaceId, session.agentId, session.vendor, session.sessionKey]);

const channelContextFor = (input: VoiceTurnInput): VoiceChannelContext => ({
  provider: "voice",
  vendor: input.session.vendor,
  sessionKey: input.session.sessionKey,
  transport: input.transport,
});

const errorClassOf = (error: unknown): string =>
  error instanceof Error ? error.constructor.name : typeof error;

/**
 * Runs one caller turn as a chat turn on the session's conversation and re-cuts the reply into
 * sentence-sized speech. The turn's governance, routines and persistence are the chat turn's own.
 */
export class VoiceTurnService implements VoiceTurnPort {
  private readonly now: () => number;
  /**
   * In-process single flight for unbound sessions: a second first turn waits until the first one
   * binds the session, then joins its conversation. Turns on different instances can still race;
   * `bind` keeps the session on the first binding either way.
   */
  private readonly firstTurns = new Map<string, FirstTurn>();

  constructor(private readonly dependencies: VoiceTurnServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async *runTurn(input: VoiceTurnInput, signal: AbortSignal): AsyncGenerator<VoiceTurnEvent> {
    const startedAt = this.now();
    let conversationId: string | null = null;
    let speechPieceCount = 0;
    let result: VoiceTurnResult = "abandoned";
    let failure: unknown;
    let firstTurn: FirstTurn | undefined;

    try {
      const claim = await this.claimSession(input.session);
      if (claim.conversationId === null) {
        firstTurn = claim.firstTurn;
      } else {
        conversationId = claim.conversationId;
        yield { type: "conversation", conversationId };
      }

      let pending = "";
      for await (const event of this.dependencies.chat.streamTurn({
        workspaceId: input.session.workspaceId,
        agentId: input.session.agentId,
        ...(claim.conversationId ? { conversationId: claim.conversationId } : {}),
        message: input.utterance,
        sourceChannel: VOICE_SOURCE_CHANNEL,
        channelContext: channelContextFor(input),
        signal,
      })) {
        // A human-owned turn answers with `done` alone, so either event can name the conversation.
        if (!conversationId && (event.type === "conversation" || event.type === "done")) {
          conversationId = event.conversationId;
          await this.bindNewSession(input.session, conversationId);
          this.releaseFirstTurn(input.session, firstTurn);
          yield { type: "conversation", conversationId };
        }

        if (event.type === "chunk") {
          const { sentences, remainder } = splitCompleteSentences(pending + event.text);
          pending = remainder;
          for (const text of sentences) {
            speechPieceCount += 1;
            yield { type: "speech", text, last: false };
          }
        } else if (event.type === "done") {
          speechPieceCount += 1;
          yield { type: "speech", text: pending, last: true };
          yield { type: "outcome", outcome: { kind: "continue" } };
          result = "completed";
          // What follows `done` is suggestion enrichment, which nobody hears.
          return;
        } else if (event.type === "cancelled") {
          // A newer turn on the conversation superseded this one and owns the reply now.
          yield { type: "outcome", outcome: { kind: "continue" } };
          result = "superseded";
          return;
        }
      }
    } catch (error) {
      result = "failed";
      failure = error;
      throw error;
    } finally {
      this.releaseFirstTurn(input.session, firstTurn);
      const fields = {
        agentId: input.session.agentId,
        vendor: input.session.vendor,
        transport: input.transport,
        conversationId,
        result,
        durationMs: this.now() - startedAt,
        speechPieceCount,
      };
      if (result === "failed") {
        this.dependencies.logger.warn({ ...fields, errorClass: errorClassOf(failure) }, "Voice turn failed");
      } else {
        this.dependencies.logger.info(fields, "Voice turn finished");
      }
    }
  }

  private async claimSession(session: VoiceSessionRef): Promise<SessionClaim> {
    const key = sessionKeyOf(session);
    for (;;) {
      await this.firstTurns.get(key)?.settled;
      const conversationId = await this.dependencies.sessions.findConversationId(session);
      if (conversationId) {
        return { conversationId };
      }
      // Re-checked after the lookup: another turn may have claimed the session meanwhile.
      if (!this.firstTurns.has(key)) {
        const firstTurn = createFirstTurn();
        this.firstTurns.set(key, firstTurn);
        return { conversationId: null, firstTurn };
      }
    }
  }

  private releaseFirstTurn(session: VoiceSessionRef, firstTurn: FirstTurn | undefined): void {
    if (!firstTurn) {
      return;
    }
    const key = sessionKeyOf(session);
    if (this.firstTurns.get(key) === firstTurn) {
      this.firstTurns.delete(key);
    }
    firstTurn.settle();
  }

  private async bindNewSession(session: VoiceSessionRef, conversationId: string): Promise<void> {
    const boundConversationId = await this.dependencies.sessions.bind(session, conversationId);
    if (boundConversationId !== conversationId) {
      // Two first turns raced; the session follows the first binding, this turn's reply stays in its own.
      this.dependencies.logger.warn({
        agentId: session.agentId,
        vendor: session.vendor,
        conversationId,
        boundConversationId,
      }, "Voice session was bound to another conversation by a concurrent first turn");
    }
  }
}
