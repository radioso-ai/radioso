import type { OperatorReplySpeechClaims } from "../../chat/contracts/index.js";
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
  /** Chat's teammate replies and the claims on them, and the id each turn claims under. */
  replies: { claims: OperatorReplySpeechClaims; newClaimTurnId: () => string };
  /** Audits replies recorded as spoken, by id; without it, nothing is audited. */
  audit?: (spoken: { workspaceId: string; conversationId: string; messageIds: string[] }) => Promise<void>;
  /** Bounds a write the turn does not wait on for long; the write itself goes on either way. */
  withinTimeout: <T>(write: Promise<T>) => Promise<T>;
  logger: Pick<AppLogger, "warn">;
  metrics?: VoiceTurnMetricsSink | null;
}

type SettleStep = "claim" | "mark" | "skip" | "release";

/**
 * One turn's teammate replies: the pending ones it claims, so no other turn speaks them, the
 * speech it speaks them in ahead of its own answer, and how it settles them once the turn's fate
 * is known. Exactly-once lives in the stored claim, so this knows nothing of other turns.
 */
export class OperatorReplySpeaker {
  /** How many claimed replies were recorded as spoken once the turn settled. */
  spokenCount = 0;
  private readonly claimTurnId: string;
  /** The replies the claim took: those with words, oldest first, with how many speech pieces each is said in, and those without. */
  private taken: { conversationId: string; claimed: Array<{ messageId: string; pieceCount: number }>; wordless: string[] } | null = null;
  /** The claim, once asked for; it never rejects. Settling waits for it, so a claim in flight is settled too. */
  private claiming: Promise<unknown> | null = null;
  private claimLanded = false;
  private settled: Promise<void> | null = null;

  constructor(
    private readonly dependencies: OperatorReplySpeakerDependencies,
    private readonly session: Pick<VoiceSessionRef, "workspaceId" | "agentId" | "vendor">,
  ) {
    this.claimTurnId = dependencies.replies.newClaimTurnId();
  }

  /** Whether the turn holds claims, or is writing one, that it has not settled. */
  get holdsClaims(): boolean {
    return this.claiming !== null && this.settled === null && (!this.claimLanded || this.holdsReplies());
  }

  /**
   * Claims and reads the conversation's pending replies in one write; a reply another turn claimed
   * first is left to that turn. Resolves those with words to say, oldest first; the rest are
   * skipped when the turn settles. A claim that cannot be written leaves the replies to a later
   * turn, and a turn claims once.
   */
  async claim(conversationId: string): Promise<ClaimedOperatorReply[]> {
    if (this.claiming) {
      return [];
    }
    const claimed = this.claimPending(conversationId);
    this.claiming = claimed;
    return claimed;
  }

  private async claimPending(conversationId: string): Promise<ClaimedOperatorReply[]> {
    try {
      const pending = await this.dependencies.replies.claims.claimPendingOperatorReplies({
        workspaceId: this.session.workspaceId,
        conversationId,
        claimTurnId: this.claimTurnId,
      });
      const replies = pending.map((reply) => ({ messageId: reply.messageId, speech: wholeTextSpeech(reply.text) }));
      const speakable = replies.filter((reply) => reply.speech.length > 0);
      this.taken = {
        conversationId,
        claimed: speakable.map((reply) => ({ messageId: reply.messageId, pieceCount: reply.speech.length })),
        wordless: replies.filter((reply) => reply.speech.length === 0).map((reply) => reply.messageId),
      };
      return speakable;
    } catch (error) {
      this.warnUnsettled(conversationId, "claim", error);
      return [];
    } finally {
      this.claimLanded = true;
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
   * `heardThrough`: how many pieces of the turn's speech, counted from the first piece of the first
   * claimed reply, the caller heard through, because the runtime had more of the turn (a later
   * piece, or the outcome) before the turn lost its caller; null when the turn failed and nobody
   * knows. A reply whose pieces all lie within that count is recorded as spoken, and only then
   * counted and audited. The rest, the reply the caller cut into included, go back to pending, so
   * the next turn speaks them whole. Replies with no words to say are skipped. The first settle
   * decides: a later one resolves with it. Null when the turn claimed nothing.
   */
  settle(heardThrough: number | null): Promise<void> | null {
    if (!this.settled && this.claiming) {
      if (this.claimLanded && !this.holdsReplies()) {
        // A claim that took nothing has nothing to settle; the turn need not wait on it.
        this.settled = Promise.resolve();
        return null;
      }
      this.settled = this.claiming.then(() => this.settleClaims(heardThrough));
    }
    return this.settled;
  }

  private holdsReplies(): boolean {
    return this.taken !== null && (this.taken.claimed.length > 0 || this.taken.wordless.length > 0);
  }

  private async settleClaims(heardThrough: number | null): Promise<void> {
    const { taken } = this;
    if (!taken) {
      return;
    }
    const heard: string[] = [];
    const unheard: string[] = [];
    let piecesSpoken = 0;
    for (const reply of taken.claimed) {
      piecesSpoken += reply.pieceCount;
      (heardThrough !== null && piecesSpoken <= heardThrough ? heard : unheard).push(reply.messageId);
    }
    const writes: Array<Promise<unknown>> = [];
    if (taken.wordless.length > 0) {
      writes.push(this.settleWrite("skip", taken.wordless));
    }
    if (heard.length > 0) {
      writes.push(this.recordSpoken(heard));
    }
    if (unheard.length > 0) {
      writes.push(this.settleWrite("release", unheard));
    }
    await Promise.all(writes);
  }

  private async recordSpoken(messageIds: string[]): Promise<void> {
    const marked = await this.settleWrite("mark", messageIds);
    if (marked.length === 0) {
      return;
    }
    this.spokenCount = marked.length;
    recordVoiceOperatorRepliesSpoken(this.dependencies.metrics, marked.length);
    const { audit } = this.dependencies;
    const conversationId = this.taken!.conversationId;
    if (audit) {
      await this.dependencies.withinTimeout(audit({ workspaceId: this.session.workspaceId, conversationId, messageIds: marked })).catch((error: unknown) => {
        this.dependencies.logger.warn(this.fields(conversationId, error), "Voice turn note could not be recorded");
      });
    }
  }

  /** One settling write, bounded like a note; one that fails leaves the claim to expire. Resolves the ids it changed. */
  private async settleWrite(step: Exclude<SettleStep, "claim">, messageIds: string[]): Promise<string[]> {
    const { claims } = this.dependencies.replies;
    const conversationId = this.taken!.conversationId;
    const claim = { workspaceId: this.session.workspaceId, conversationId, messageIds, claimTurnId: this.claimTurnId };
    const write = step === "mark"
      ? claims.markOperatorRepliesSpoken(claim)
      : step === "skip" ? claims.skipOperatorReplies(claim) : claims.releaseOperatorReplies(claim);
    try {
      return await this.dependencies.withinTimeout(write);
    } catch (error) {
      this.warnUnsettled(conversationId, step, error);
      return [];
    }
  }

  private warnUnsettled(conversationId: string, step: SettleStep, error: unknown): void {
    this.dependencies.logger.warn({ ...this.fields(conversationId, error), step }, "Voice turn could not update the teammate's pending replies");
  }

  private fields(conversationId: string, error: unknown) {
    return { agentId: this.session.agentId, vendor: this.session.vendor, conversationId, errorClass: errorClassOf(error) };
  }
}
