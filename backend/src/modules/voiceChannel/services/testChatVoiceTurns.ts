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
 * for the running one to settle, and the test records both in order. The caller who spoke over the
 * earlier answer hears the newer one.
 */
export class TestChatVoiceTurnService {
  private readonly now: () => number;
  /** Each session's running turn, settled or not, so the next one starts after it. */
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: TestChatVoiceTurnServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async *runTurn(input: VoiceTurnInput, binding: VoiceTestChatBinding, signal: AbortSignal): AsyncGenerator<VoiceTurnEvent> {
    if (input.languageSwitchResult) {
      // No Test Chat turn asks the runtime to switch the call's language, so there is nothing to speak.
      yield CONTINUE;
      return;
    }
    const key = sessionKeyOf(input.session);
    const previous = this.running.get(key) ?? Promise.resolve();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const current = previous.then(() => settled);
    this.running.set(key, current);
    const startedAt = this.now();
    let firstSpeechMs: number | null = null;
    try {
      await previous;
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
      settle();
      if (this.running.get(key) === current) this.running.delete(key);
    }
  }

  private async *speak(input: VoiceTurnInput, binding: VoiceTestChatBinding, signal: AbortSignal): AsyncGenerator<VoiceTurnEvent> {
    const speech = createSentenceCutter();
    let written = "";
    for await (const event of this.dependencies.turns.streamTurn({
      workspaceId: input.session.workspaceId,
      agentId: input.session.agentId,
      testExecutionId: binding.testExecutionId,
      accountId: binding.accountId,
      utterance: input.utterance,
      signal,
    })) {
      if (event.type === "failed") throw new VoiceTestChatTurnFailedError(event.code);
      // The stored answer is the authority: only what it adds past the streamed text is still to say.
      const text = event.type === "text"
        ? event.text
        : event.answer.startsWith(written) ? event.answer.slice(written.length) : "";
      written += text;
      for (const piece of speech.push(text)) yield { type: "speech", text: piece.text, last: false };
      if (event.type === "answered") {
        const rest = speech.finish();
        for (const sentence of rest.sentences) yield { type: "speech", text: sentence.text, last: false };
        yield { type: "speech", text: rest.remainder.text, last: true };
        yield CONTINUE;
        return;
      }
    }
    throw new VoiceTurnIncompleteError();
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
