import type { OperatorReplyClaim, OperatorReplySpeechClaims, PendingOperatorReply } from "../../chat/contracts/index.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { VoiceSessionRef, VoiceTurnEvent } from "../domain.js";
import { wholeTextSpeech } from "./speechSegmenter.js";
import { recordVoiceOperatorRepliesSpoken, type VoiceTurnMetricsSink } from "./voiceTurnMetrics.js";

/** A teammate's reply a turn claimed, as the speech pieces it is spoken in. */
export interface ClaimedOperatorReply {
  messageId: string;
  speech: string[];
}

export interface OperatorReplySpeakerDependencies {
  /** Chat's pending teammate replies and the claims on them, and the id each turn claims under. */
  replies?: { claims: OperatorReplySpeechClaims; newClaimTurnId: () => string };
  /** Records the claimed replies as spoken; resolves the ids it recorded. */
  recordSpoken?: (claimed: OperatorReplyClaim) => Promise<string[]>;
  /** Bounds a write the turn does not wait on for long; the write itself goes on either way. */
  withinTimeout: <T>(write: Promise<T>) => Promise<T>;
  logger: Pick<AppLogger, "warn">;
  metrics?: VoiceTurnMetricsSink | null;
}

const NO_OPERATOR_REPLIES: readonly PendingOperatorReply[] = [];

type SettleStep = "claim" | "skip" | "release";

/**
 * One turn's teammate replies: the pending ones it claims, so no other turn speaks them, the
 * speech it speaks them in ahead of its own answer, and how it settles them once the turn's fate
 * is known. Exactly-once lives in the stored claim, so this knows nothing of other turns.
 */
export class OperatorReplySpeaker {
  /** How many claimed replies were recorded as spoken once the turn settled. */
  spokenCount = 0;
  private taken: { conversationId: string; claimTurnId: string; claimed: string[]; wordless: string[] } | null = null;

  constructor(
    private readonly dependencies: OperatorReplySpeakerDependencies,
    private readonly session: Pick<VoiceSessionRef, "workspaceId" | "agentId" | "vendor">,
  ) {}

  /**
   * The teammate replies the conversation holds that the caller has not heard. A read that fails
   * leaves them pending, so the turn runs as chat answers it and the next turn speaks them.
   */
  async pending(conversationId: string | null): Promise<readonly PendingOperatorReply[]> {
    const source = this.dependencies.replies;
    if (!source || !conversationId) {
      return NO_OPERATOR_REPLIES;
    }
    try {
      return await source.claims.pendingOperatorReplies({ workspaceId: this.session.workspaceId, conversationId });
    } catch (error) {
      this.dependencies.logger.warn(
        this.fields(conversationId, error),
        "Voice turn could not read the teammate's pending replies; they wait for the next turn",
      );
      return NO_OPERATOR_REPLIES;
    }
  }

  /**
   * Claims the pending replies that have words to say; a reply another turn claimed first is left
   * to that turn. A claim that cannot be written leaves the replies to a later turn.
   */
  async claim(conversationId: string, pending: readonly PendingOperatorReply[]): Promise<ClaimedOperatorReply[]> {
    const source = this.dependencies.replies;
    if (!source || pending.length === 0) {
      return [];
    }
    const spoken = pending.map((reply) => ({ messageId: reply.messageId, speech: wholeTextSpeech(reply.text) }));
    const speakable = spoken.filter((reply) => reply.speech.length > 0);
    const taken = {
      conversationId,
      claimTurnId: source.newClaimTurnId(),
      claimed: [] as string[],
      wordless: spoken.filter((reply) => reply.speech.length === 0).map((reply) => reply.messageId),
    };
    this.taken = taken;
    if (speakable.length === 0) {
      return [];
    }
    try {
      const claimed = new Set(await source.claims.claimOperatorReplies({
        workspaceId: this.session.workspaceId,
        conversationId,
        messageIds: speakable.map((reply) => reply.messageId),
        claimTurnId: taken.claimTurnId,
      }));
      const replies = speakable.filter((reply) => claimed.has(reply.messageId));
      taken.claimed = replies.map((reply) => reply.messageId);
      return replies;
    } catch (error) {
      this.warnUnsettled(conversationId, "claim", error);
      return [];
    }
  }

  /** The claimed replies as speech pieces, in the order they were written; none is the last piece. */
  *speech(replies: readonly ClaimedOperatorReply[]): Generator<Extract<VoiceTurnEvent, { type: "speech" }>> {
    for (const reply of replies) {
      for (const text of reply.speech) {
        yield { type: "speech", text, last: false };
      }
    }
  }

  /**
   * `heard`: the turn's outcome left before it was cut off, so the caller heard the claimed replies;
   * they are recorded as spoken, and only then counted. Otherwise they go back to pending for the
   * next turn. Replies with no words to say are skipped. Null when the turn took on no replies.
   */
  settle(heard: boolean): Promise<void> | null {
    const { taken } = this;
    const source = this.dependencies.replies;
    if (!taken || !source) {
      return null;
    }
    const conversation = { workspaceId: this.session.workspaceId, conversationId: taken.conversationId };
    const writes: Array<Promise<unknown>> = [];
    if (taken.wordless.length > 0) {
      writes.push(this.settleWrite(taken.conversationId, "skip", source.claims.skipOperatorReplies({ ...conversation, messageIds: taken.wordless })));
    }
    if (taken.claimed.length > 0) {
      const claimed: OperatorReplyClaim = { ...conversation, messageIds: taken.claimed, claimTurnId: taken.claimTurnId };
      writes.push(heard
        ? this.recordSpoken(claimed)
        : this.settleWrite(taken.conversationId, "release", source.claims.releaseOperatorReplies(claimed)));
    }
    return Promise.all(writes).then(() => undefined);
  }

  private async recordSpoken(claimed: OperatorReplyClaim): Promise<void> {
    const { recordSpoken } = this.dependencies;
    if (!recordSpoken) {
      return;
    }
    try {
      const marked = await this.dependencies.withinTimeout(recordSpoken(claimed));
      this.spokenCount = marked.length;
      if (marked.length > 0) {
        recordVoiceOperatorRepliesSpoken(this.dependencies.metrics, marked.length);
      }
    } catch (error) {
      // The claim stays until it expires; a later turn then speaks the replies again.
      this.dependencies.logger.warn(this.fields(claimed.conversationId, error), "Voice turn note could not be recorded");
    }
  }

  /** A skip or a release, bounded like a note; one that fails leaves the claim to expire. */
  private settleWrite(conversationId: string, step: SettleStep, write: Promise<unknown>): Promise<void> {
    return this.dependencies.withinTimeout(write).then(
      () => undefined,
      (error: unknown) => this.warnUnsettled(conversationId, step, error),
    );
  }

  private warnUnsettled(conversationId: string, step: SettleStep, error: unknown): void {
    this.dependencies.logger.warn({ ...this.fields(conversationId, error), step }, "Voice turn could not update the teammate's pending replies");
  }

  private fields(conversationId: string, error: unknown) {
    return { agentId: this.session.agentId, vendor: this.session.vendor, conversationId, errorClass: errorClassOf(error) };
  }
}
