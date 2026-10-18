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

/**
 * The turns of each session that asked the runtime to switch the call's language and wait for its
 * follow-up to speak their answer, in this process. At most one per session: a turn held for the
 * session goes unanswered once another is held, the session's caller says something new, or the
 * window passes. In-process only, like the session memory: a follow-up on another instance finds
 * nothing here.
 */
export class SwitchedTurns<Turn> {
  private readonly held = new Map<string, HeldTurn<Turn>>();

  constructor(
    private readonly windowMs: number,
    private readonly unanswered: (turn: Turn) => void,
  ) {}

  hold(sessionKey: string, entry: { switchId: string; utterance: string; turn: Turn }): void {
    this.drop(sessionKey);
    const timer = setTimeout(() => {
      if (this.held.get(sessionKey)?.turn === entry.turn) {
        this.held.delete(sessionKey);
        this.unanswered(entry.turn);
      }
    }, this.windowMs);
    timer.unref?.();
    this.held.set(sessionKey, { ...entry, timer });
  }

  /** The held turn a follow-up speaks: the session's, by its switch id, for the same utterance. Taken once. */
  take(sessionKey: string, switchId: string, utterance: string): Turn | null {
    const held = this.held.get(sessionKey);
    if (!held || held.switchId !== switchId || !sameUtterance(held.utterance, utterance)) {
      return null;
    }
    clearTimeout(held.timer);
    this.held.delete(sessionKey);
    return held.turn;
  }

  /** The session's held turn will not be followed up. */
  drop(sessionKey: string): void {
    const held = this.held.get(sessionKey);
    if (!held) return;
    clearTimeout(held.timer);
    this.held.delete(sessionKey);
    this.unanswered(held.turn);
  }
}
