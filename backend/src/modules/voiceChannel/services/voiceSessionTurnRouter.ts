import { notFound } from "../../../shared/domain/errors.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { VoiceTestChatBinding, VoiceTestChatBindingLookup, VoiceTurnEvent, VoiceTurnInput, VoiceTurnPort } from "../domain.js";
import { VOICE_TEST_CHAT_TURN_LOG_EVENT } from "./testChatVoiceTurns.js";

interface VoiceSessionTurnRouterDependencies {
  bindings: VoiceTestChatBindingLookup;
  /** A session's turn as a conversation on the agent's published release: `VoiceTurnService`. */
  conversations: VoiceTurnPort;
  /** A Test Chat session's turn on its private test: `TestChatVoiceTurnService`. */
  testChats: { runTurn(input: VoiceTurnInput, binding: VoiceTestChatBinding, signal: AbortSignal): AsyncIterable<VoiceTurnEvent> };
  now?: () => number;
  logger: Pick<AppLogger, "warn">;
}

/**
 * The one `VoiceTurnPort` the vendor adapters call. The session key is all a runtime's turn carries,
 * so what the session was started for decides where the turn runs: a session started from Test Chat
 * runs on its private test, and every other session as a conversation. The binding is read first,
 * and a session started from Test Chat never reaches the conversation path, not once its window has
 * passed and not when the binding cannot be read: such a turn is refused instead.
 */
export class VoiceSessionTurnRouter implements VoiceTurnPort {
  private readonly now: () => number;

  constructor(private readonly dependencies: VoiceSessionTurnRouterDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async *runTurn(input: VoiceTurnInput, signal: AbortSignal, hungUp?: AbortSignal): AsyncGenerator<VoiceTurnEvent> {
    const binding = await this.dependencies.bindings.findTestChatBinding(input.session);
    if (!binding) {
      yield* this.dependencies.conversations.runTurn(input, signal, hungUp);
      return;
    }
    if (binding.expiresAt.getTime() <= this.now()) {
      this.dependencies.logger.warn(
        {
          event: VOICE_TEST_CHAT_TURN_LOG_EVENT,
          workspaceId: input.session.workspaceId,
          agentId: input.session.agentId,
          vendor: input.session.vendor,
          testExecutionId: binding.testExecutionId,
          result: "session_ended",
        },
        "Test Chat voice turn refused: the session's window has passed",
      );
      throw notFound("This voice session has ended.");
    }
    yield* this.dependencies.testChats.runTurn(input, binding, signal);
  }
}
