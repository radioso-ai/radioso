import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import {
  VoiceTurnIncompleteError,
  type VoiceSessionRef,
  type VoiceTestChatBinding,
  type VoiceTestChatTurns,
  type VoiceTurnEvent,
  type VoiceTurnInput,
} from "../domain.js";
import { createSentenceCutter } from "./speechSegmenter.js";

/** The `event` field of a Test Chat voice turn's one log line, apart from `voice.turn`, which the voice turn health alert counts. */
export const VOICE_TEST_CHAT_TURN_LOG_EVENT = "voice.test_chat_turn";

/** A Test Chat turn the test settled as failed, with the test's own code. */
class VoiceTestChatTurnFailedError extends Error {
  constructor(readonly failureCode: string) {
    super(`The test's turn failed: ${failureCode}`);
    this.name = new.target.name;
  }
}

const CONTINUE: VoiceTurnEvent = { type: "outcome", outcome: { kind: "continue" } };

/** Settles once `signal` aborts, at once when it has. */
const abortedOf = (signal: AbortSignal): Promise<void> =>
  signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));

const sessionKeyOf = (session: VoiceSessionRef): string =>
  JSON.stringify([session.workspaceId, session.agentId, session.vendor, session.sessionKey]);

interface TestChatVoiceTurnServiceDependencies {
  turns: VoiceTestChatTurns;
  logger: Pick<AppLogger, "info" | "warn">;
  now?: () => number;
}

/**
 * Runs a Test Chat session's utterance as a turn of the private test it was started from, and cuts
 * the answer into the same sentence-sized speech a conversation's turn hands the runtime. The test
 * owns the turn: which revision answers, what it records and what it charges. It speaks no bridge or
 * fallback line: those wait on chat's phases, which the test's runner does not report.
 *
 * A test runs one turn at a time, so a newer utterance of the session waits here, in this process,
 * for the running one to settle, and the test records both in order; the caller who spoke over the
 * earlier answer hears the newer one. At most one utterance waits per session: a newer one replaces
 * it, and a waiting one whose request was aborted or whose runtime hung up runs no turn, so the test
 * neither records nor charges what nobody is listening for.
 */
export class TestChatVoiceTurnService {
  private readonly now: () => number;
  /** Each session's running turn, settled or not, so the next one starts after it. */
  private readonly running = new Map<string, Promise<void>>();
  /** Each session's one waiting utterance, which a newer one replaces. */
  private readonly waiting = new Map<string, AbortController>();

  constructor(private readonly dependencies: TestChatVoiceTurnServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async *runTurn(input: VoiceTurnInput, binding: VoiceTestChatBinding, signal: AbortSignal, hungUp?: AbortSignal): AsyncGenerator<VoiceTurnEvent> {
    if (input.languageSwitchResult) {
      // No Test Chat turn asks the runtime to switch the call's language, so there is nothing to speak.
      yield CONTINUE;
      return;
    }
    const key = sessionKeyOf(input.session);
    const startedAt = this.now();
    const turn = await this.takeTurn(key, signal, hungUp);
    if (turn.kind === "skipped") {
      this.dependencies.logger.info(
        { ...this.logFields(input, binding), result: turn.reason, durationMs: this.now() - startedAt },
        "Test Chat voice turn not run",
      );
      yield CONTINUE;
      return;
    }
    let firstSpeechMs: number | null = null;
    try {
      for await (const event of this.speak(input, binding, signal)) {
        if (event.type === "speech" && firstSpeechMs === null) firstSpeechMs = this.now() - startedAt;
        yield event;
      }
      this.dependencies.logger.info(
        { ...this.logFields(input, binding), result: "completed", durationMs: this.now() - startedAt, firstSpeechMs },
        "Test Chat voice turn finished",
      );
    } catch (error) {
      this.dependencies.logger.warn(
        {
          ...this.logFields(input, binding),
          result: "failed",
          durationMs: this.now() - startedAt,
          ...(error instanceof VoiceTestChatTurnFailedError ? { failureCode: error.failureCode } : { errorClass: errorClassOf(error) }),
        },
        "Test Chat voice turn failed",
      );
      throw error;
    } finally {
      turn.release();
    }
  }

  /**
   * Takes the session's turn once the running one settles, waiting as the session's one waiting
   * utterance. Skipped when a newer utterance replaced it or nobody is left to hear it. Nothing awaits
   * between the last check and taking the turn, so no other utterance of the session runs beside it.
   */
  private async takeTurn(
    key: string,
    signal: AbortSignal,
    hungUp?: AbortSignal,
  ): Promise<{ kind: "skipped"; reason: "superseded" | "abandoned" } | { kind: "taken"; release: () => void }> {
    this.waiting.get(key)?.abort();
    const waiter = new AbortController();
    this.waiting.set(key, waiter);
    const previous = this.running.get(key);
    if (previous) {
      await Promise.race([previous, abortedOf(waiter.signal), abortedOf(signal), ...(hungUp ? [abortedOf(hungUp)] : [])]);
    }
    if (this.waiting.get(key) === waiter) this.waiting.delete(key);
    if (waiter.signal.aborted) return { kind: "skipped", reason: "superseded" };
    if (signal.aborted || hungUp?.aborted) return { kind: "skipped", reason: "abandoned" };
    let settle!: () => void;
    const current = new Promise<void>((resolve) => { settle = resolve; });
    this.running.set(key, current);
    return {
      kind: "taken",
      release: () => {
        settle();
        if (this.running.get(key) === current) this.running.delete(key);
      },
    };
  }

  private async *speak(input: VoiceTurnInput, binding: VoiceTestChatBinding, signal: AbortSignal): AsyncGenerator<VoiceTurnEvent> {
    const speech = createSentenceCutter();
    let written = "";
    let answered = false;
    const turn = this.dependencies.turns.streamTurn({
      workspaceId: input.session.workspaceId,
      agentId: input.session.agentId,
      testExecutionId: binding.testExecutionId,
      accountId: binding.accountId,
      utterance: input.utterance,
      signal,
    });
    try {
      for await (const event of turn) {
        if (answered) continue;
        if (event.type === "failed") throw new VoiceTestChatTurnFailedError(event.code);
        // The stored answer is the authority: only what it adds past the streamed text is still to say.
        const text = event.type === "text"
          ? event.text
          : event.answer.startsWith(written) ? event.answer.slice(written.length) : "";
        written += text;
        for (const piece of speech.push(text)) yield { type: "speech", text: piece.text, last: false };
        if (event.type === "answered") {
          answered = true;
          const rest = speech.finish();
          for (const sentence of rest.sentences) yield { type: "speech", text: sentence.text, last: false };
          yield { type: "speech", text: rest.remainder.text, last: true };
        }
      }
    } catch (error) {
      // The caller has heard the whole answer; what failed is the test settling it afterwards.
      if (!answered) throw error;
      this.dependencies.logger.warn(
        { ...this.logFields(input, binding), result: "settle_failed", errorClass: errorClassOf(error) },
        "Test Chat voice turn was spoken, but the test could not settle it",
      );
    }
    // The test's stream is read to its end, where the test settles the turn and audits it.
    if (!answered) throw new VoiceTurnIncompleteError();
    yield CONTINUE;
  }

  /** Ids and closed values only: never what was said. */
  private logFields(input: VoiceTurnInput, binding: VoiceTestChatBinding) {
    return {
      event: VOICE_TEST_CHAT_TURN_LOG_EVENT,
      workspaceId: input.session.workspaceId,
      agentId: input.session.agentId,
      vendor: input.session.vendor,
      testExecutionId: binding.testExecutionId,
    };
  }
}
