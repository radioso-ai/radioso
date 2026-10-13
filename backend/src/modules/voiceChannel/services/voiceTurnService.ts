import type { ChatStreamEvent } from "../../chat/contracts/index.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { VOICE_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { VOICE_SOURCE_CHANNEL } from "../../../shared/domain/conversationSource.js";
import type { AgentVoiceSettings } from "../../agents/public.js";
import type {
  VoiceChannelContext,
  VoiceSessionRef,
  VoiceTurnEvent,
  VoiceTurnInput,
  VoiceTurnPort,
} from "../domain.js";
import { chooseVoiceTurnLines, resolveVoiceTurnLocale } from "./voiceLines.js";
import { recordVoiceBridgeDue, recordVoiceFirstSpeech, recordVoiceTurnLimit, type VoiceTurnMetricsSink } from "./voiceTurnMetrics.js";
import { applyVoiceTurnPolicy, type VoiceTurnPolicy } from "./voiceTurnPolicy.js";
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

/** What a voice turn needs from the agent's settings. */
interface VoiceAgentProfile {
  voice: AgentVoiceSettings;
  /** The agent's default language tag, which a turn speaks in when the request names none. */
  defaultLocale: string | null;
}

interface VoiceAgentProfileSource {
  /** Null when the agent no longer exists; the turn then runs without the policy and fails in chat. */
  findVoiceProfile(agent: Pick<VoiceSessionRef, "workspaceId" | "agentId">): Promise<VoiceAgentProfile | null>;
}

interface VoiceRoutineStateSource {
  /** Whether a routine is mid-flight in the conversation. */
  isRoutineActive(conversationId: string): Promise<boolean>;
}

interface VoiceTurnTiming {
  bridgeAfterMs: number;
  turnLimitMs: number;
}

interface VoiceTurnServiceDependencies {
  sessions: VoiceSessionStore;
  chat: VoiceChatPort;
  agents: VoiceAgentProfileSource;
  routines: VoiceRoutineStateSource;
  logger: Pick<AppLogger, "info" | "warn">;
  metrics?: VoiceTurnMetricsSink | null;
  /** Overrides `VOICE_BEHAVIOR`; tests only. */
  timing?: VoiceTurnTiming;
  now?: () => number;
}

type VoiceTurnResult = "completed" | "superseded" | "abandoned" | "failed";

/** What the turn's one log record reports. */
interface VoiceTurnRecord {
  conversationId: string | null;
  speechPieceCount: number;
  result: VoiceTurnResult;
  /** Present when the agent's voice policy ran. */
  policy?: { bridged: boolean; turnLimitReached: boolean; fallbackSpoken: boolean };
}

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
  private readonly timing: VoiceTurnTiming;
  /** Picks the next authored bridge line on each policy turn this process runs, whatever the session. */
  private policyTurns = 0;
  /**
   * In-process single flight for unbound sessions: a second first turn waits until the first one
   * binds the session, then joins its conversation. Turns on different instances can still race;
   * `bind` keeps the session on the first binding either way.
   */
  private readonly firstTurns = new Map<string, FirstTurn>();

  constructor(private readonly dependencies: VoiceTurnServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.timing = dependencies.timing ?? VOICE_BEHAVIOR;
  }

  async *runTurn(input: VoiceTurnInput, signal: AbortSignal): AsyncGenerator<VoiceTurnEvent> {
    const startedAt = this.now();
    const record: VoiceTurnRecord = { conversationId: null, speechPieceCount: 0, result: "abandoned" };
    let failure: unknown;
    let firstTurn: FirstTurn | undefined;

    try {
      const claim = await this.claimSession(input.session);
      if (claim.conversationId === null) {
        firstTurn = claim.firstTurn;
      } else {
        record.conversationId = claim.conversationId;
        yield { type: "conversation", conversationId: claim.conversationId };
      }

      const policy = await this.policyFor(input, claim.conversationId, startedAt, record);
      const reply = this.replyEvents(input, claim.conversationId, firstTurn, record, signal);
      yield* policy ? applyVoiceTurnPolicy(reply, policy) : reply;
    } catch (error) {
      record.result = "failed";
      failure = error;
      throw error;
    } finally {
      this.releaseFirstTurn(input.session, firstTurn);
      const fields = {
        agentId: input.session.agentId,
        vendor: input.session.vendor,
        transport: input.transport,
        conversationId: record.conversationId,
        result: record.result,
        durationMs: this.now() - startedAt,
        speechPieceCount: record.speechPieceCount,
        ...record.policy,
      };
      if (record.result === "failed") {
        this.dependencies.logger.warn({ ...fields, errorClass: errorClassOf(failure) }, "Voice turn failed");
      } else if (record.policy?.turnLimitReached) {
        // The caller heard the fallback line, or kept waiting when the agent has none for the locale.
        this.dependencies.logger.warn(fields, "Voice turn reached the turn limit");
      } else {
        this.dependencies.logger.info(fields, "Voice turn finished");
      }
    }
  }

  /** The chat turn's reply as voice events, re-cut into sentences. Binds a new session as soon as chat names its conversation. */
  private async *replyEvents(
    input: VoiceTurnInput,
    boundConversationId: string | null,
    firstTurn: FirstTurn | undefined,
    record: VoiceTurnRecord,
    signal: AbortSignal,
  ): AsyncGenerator<VoiceTurnEvent> {
    let pending = "";
    for await (const event of this.dependencies.chat.streamTurn({
      workspaceId: input.session.workspaceId,
      agentId: input.session.agentId,
      ...(boundConversationId ? { conversationId: boundConversationId } : {}),
      message: input.utterance,
      sourceChannel: VOICE_SOURCE_CHANNEL,
      channelContext: channelContextFor(input),
      signal,
    })) {
      // A human-owned turn answers with `done` alone, so either event can name the conversation.
      if (!record.conversationId && (event.type === "conversation" || event.type === "done")) {
        record.conversationId = event.conversationId;
        await this.bindNewSession(input.session, record.conversationId);
        this.releaseFirstTurn(input.session, firstTurn);
        yield { type: "conversation", conversationId: record.conversationId };
      }

      if (event.type === "chunk") {
        const { sentences, remainder } = splitCompleteSentences(pending + event.text);
        pending = remainder;
        for (const text of sentences) {
          record.speechPieceCount += 1;
          yield { type: "speech", text, last: false };
        }
      } else if (event.type === "done") {
        record.speechPieceCount += 1;
        yield { type: "speech", text: pending, last: true };
        yield { type: "outcome", outcome: { kind: "continue" } };
        record.result = "completed";
        // What follows `done` is suggestion enrichment, which nobody hears.
        return;
      } else if (event.type === "cancelled") {
        // A newer turn on the conversation superseded this one and owns the reply now.
        yield { type: "outcome", outcome: { kind: "continue" } };
        record.result = "superseded";
        return;
      }
    }
  }

  /**
   * The bridge and the turn limit, when the agent has voice on. Two primary-key reads: the agent's
   * settings, and the conversation's routine state (a session's first turn has no routine yet).
   */
  private async policyFor(
    input: VoiceTurnInput,
    conversationId: string | null,
    startedAt: number,
    record: VoiceTurnRecord,
  ): Promise<VoiceTurnPolicy | null> {
    const [profile, routineActive] = await Promise.all([
      this.dependencies.agents.findVoiceProfile(input.session),
      conversationId ? this.dependencies.routines.isRoutineActive(conversationId) : Promise.resolve(false),
    ]);
    if (!profile?.voice.enabled) {
      return null;
    }
    const lines = chooseVoiceTurnLines(profile.voice, {
      locale: resolveVoiceTurnLocale({ requested: input.locale, agentDefault: profile.defaultLocale }),
      routineActive,
      rotation: this.policyTurns++,
    });
    const outcome = { bridged: false, turnLimitReached: false, fallbackSpoken: false };
    record.policy = outcome;
    const { metrics } = this.dependencies;
    return {
      ...lines,
      ...this.timing,
      startedAt,
      now: this.now,
      observer: {
        bridgeDue: (style, spoken) => {
          outcome.bridged = spoken;
          recordVoiceBridgeDue(metrics, style, spoken);
        },
        turnLimitReached: (spoken) => {
          outcome.turnLimitReached = true;
          outcome.fallbackSpoken = spoken;
          recordVoiceTurnLimit(metrics, spoken);
        },
        firstSpeech: (elapsedMs, bridged) => recordVoiceFirstSpeech(metrics, elapsedMs, bridged),
      },
    };
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
