import { notFound } from "../../../shared/domain/errors.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { VoiceTestChatBindingLookup, VoiceTurnEvent, VoiceTurnInput, VoiceTurnPort } from "../domain.js";
import { isTestChatSession, type VoiceTestChatBinding } from "../testChatSessionDomain.js";
import { VOICE_TEST_CHAT_TURN_LOG_EVENT } from "./testChatVoiceTurns.js";

interface VoiceSessionTurnRouterDependencies {
  bindings: VoiceTestChatBindingLookup;
  /** A session's turn as a conversation on the agent's published release: `VoiceTurnService`. */
  conversations: VoiceTurnPort;
  /** A Test Chat session's turn on its private test: `TestChatVoiceTurnService`. */
  testChats: {
    runTurn(input: VoiceTurnInput, binding: VoiceTestChatBinding, signal: AbortSignal, hungUp?: AbortSignal): AsyncIterable<VoiceTurnEvent>;
  };
  now?: () => number;
  logger: Pick<AppLogger, "warn">;
}

/**
 * The one `VoiceTurnPort` the vendor adapters call. The session key is all a runtime's turn carries,
 * and Radioso mints a Test Chat session's key in a form it reserves (`isTestChatSession`), so the
 * key alone decides the path: every other session runs as a conversation, with no extra read, and a
 * Test Chat session runs on its private test while its binding is live. A Test Chat key whose binding
 * is gone or past its window, or cannot be read, is refused; it never reaches the conversation path.
 */
export class VoiceSessionTurnRouter implements VoiceTurnPort {
  private readonly now: () => number;

  constructor(private readonly dependencies: VoiceSessionTurnRouterDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async *runTurn(input: VoiceTurnInput, signal: AbortSignal, hungUp?: AbortSignal): AsyncGenerator<VoiceTurnEvent> {
    if (!isTestChatSession(input.session)) {
      yield* this.dependencies.conversations.runTurn(input, signal, hungUp);
      return;
    }
    const binding = await this.dependencies.bindings.findTestChatBinding(input.session);
    if (!binding || binding.expiresAt.getTime() <= this.now()) {
      this.dependencies.logger.warn(
        {
          event: VOICE_TEST_CHAT_TURN_LOG_EVENT,
          workspaceId: input.session.workspaceId,
          agentId: input.session.agentId,
          vendor: input.session.vendor,
          testExecutionId: binding?.testExecutionId ?? null,
          result: "session_ended",
        },
        "Test Chat voice turn refused: the session has ended",
      );
      throw notFound("This voice session has ended.");
    }
    yield* this.dependencies.testChats.runTurn(input, binding, signal, hungUp);
  }
}
