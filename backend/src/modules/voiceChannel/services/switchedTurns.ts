import type { VoiceTurnOutcome } from "../domain.js";
import { sameUtterance } from "./voiceSessionMemory.js";
import type { VoiceReplyEvent, VoiceTurnDrain, VoiceTurnPhase } from "./voiceTurnPolicy.js";

/**
 * The reply of a turn that asked the runtime to switch the call's language, running on after its
 * request ended. It is pulled to its end whether or not anyone speaks it, so the chat turn finishes
 * and stores its answer as any turn does, and it is kept for the runtime's follow-up request to
 * speak: from the phases the turn reported before the switch to its outcome.
 */
export class SwitchedReply {
  private readonly events: VoiceReplyEvent[];
  private end: VoiceTurnDrain | null = null;
  private waiting: Array<() => void> = [];
  /** Settles once the reply has run to its end, with its failure if it failed. */
  readonly drained: Promise<VoiceTurnDrain>;

  constructor(rest: AsyncIterable<VoiceReplyEvent>, phasesSeen: readonly VoiceTurnPhase[]) {
    this.events = phasesSeen.map((phase) => ({ type: "phase", phase }));
    this.drained = this.pull(rest);
  }

  /**
   * The reply's events from its first, as far as they have come, then as they come; it fails as the
   * reply did. A phase the reply has already moved past (speech or the outcome came after it) is
   * left out, so a follow-up that finds the answer written does not bridge before it.
   */
  async *read(): AsyncGenerator<VoiceReplyEvent> {
    let index = 0;
    for (;;) {
      if (index < this.events.length) {
        const event = this.events[index];
        index += 1;
        if (event && !(event.type === "phase" && this.answeredAfter(index))) yield event;
        continue;
      }
      if (this.end) {
        if (this.end.failed) throw this.end.error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
  }

  /** The reply's outcome, once it reached one. */
  outcome(): VoiceTurnOutcome | null {
    const outcome = this.events.find((event): event is Extract<VoiceReplyEvent, { type: "outcome" }> => event.type === "outcome");
    return outcome?.outcome ?? null;
  }

  /** Whether `error` is the reply's own failure, which the turn that switched reports. */
  failedWith(error: unknown): boolean {
    return this.end?.failed === true && this.end.error === error;
  }

  private answeredAfter(index: number): boolean {
    return this.events.slice(index).some((event) => event.type === "speech" || event.type === "outcome");
  }

  private async pull(rest: AsyncIterable<VoiceReplyEvent>): Promise<VoiceTurnDrain> {
    let end: VoiceTurnDrain;
    try {
      for await (const event of rest) {
        this.events.push(event);
        this.wake();
      }
      end = { failed: false };
    } catch (error) {
      end = { failed: true, error };
    }
    this.end = end;
    this.wake();
    return end;
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const resolve of waiting) resolve();
  }
}

interface HeldTurn<Turn> {
  switchId: string;
  utterance: string;
  turn: Turn;
  timer: ReturnType<typeof setTimeout>;
}

/** Why a held turn is let go without a follow-up speaking it. */
export type UnspokenSwitchReason = "unanswered" | "mismatched";

/** What a follow-up finds: the session's held turn, and whether it names the switch that turn asked for. */
type SwitchedTurnTake<Turn> = { kind: "taken"; turn: Turn; sameSwitch: boolean } | { kind: "none" };

/**
 * The turns of each session that asked the runtime to switch the call's language and wait for its
 * follow-up to speak their answer, in this process. At most one per session: a turn held for the
 * session goes `unanswered` once another is held, the session's caller says something new, or the
 * window passes, and `mismatched` when the session's follow-up is for another utterance.
 * In-process only, like the session memory: a follow-up on another instance finds nothing here.
 */
export class SwitchedTurns<Turn> {
  private readonly held = new Map<string, HeldTurn<Turn>>();

  constructor(
    private readonly windowMs: number,
    private readonly unspoken: (turn: Turn, reason: UnspokenSwitchReason) => void,
  ) {}

  hold(sessionKey: string, entry: { switchId: string; utterance: string; turn: Turn }): void {
    this.drop(sessionKey);
    const timer = setTimeout(() => {
      if (this.held.get(sessionKey)?.turn === entry.turn) {
        this.held.delete(sessionKey);
        this.unspoken(entry.turn, "unanswered");
      }
    }, this.windowMs);
    timer.unref?.();
    this.held.set(sessionKey, { ...entry, timer });
  }

  /**
   * The held turn a follow-up speaks: the session's, for the same utterance, taken once. The
   * session holds one turn at most, so the utterance decides; `sameSwitch` says whether the
   * follow-up also names its switch. A follow-up for another utterance lets the held turn go as
   * `mismatched`, since no later follow-up will be for it.
   */
  take(sessionKey: string, switchId: string, utterance: string): SwitchedTurnTake<Turn> {
    const held = this.release(sessionKey);
    if (!held) {
      return { kind: "none" };
    }
    if (!sameUtterance(held.utterance, utterance)) {
      this.unspoken(held.turn, "mismatched");
      return { kind: "none" };
    }
    return { kind: "taken", turn: held.turn, sameSwitch: held.switchId === switchId };
  }

  /** The session's held turn will not be followed up. */
  drop(sessionKey: string): void {
    const held = this.release(sessionKey);
    if (held) {
      this.unspoken(held.turn, "unanswered");
    }
  }

  private release(sessionKey: string): HeldTurn<Turn> | undefined {
    const held = this.held.get(sessionKey);
    if (held) {
      clearTimeout(held.timer);
      this.held.delete(sessionKey);
    }
    return held;
  }
}
