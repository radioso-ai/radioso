import { randomUUID } from "node:crypto";

import type { ChatStreamEvent } from "../../../src/modules/chat/contracts/index.js";
import {
  conversationQualityCaseTurnText,
  type ConversationQualityCase,
  type ConversationQualityObservedOutput,
  type ConversationQualityRunnerPort,
  type VoiceEvalChatScriptEvent,
} from "../../../src/modules/eval/suite/index.js";
import {
  VoiceTurnService,
  type VoiceChatTurnRequest,
  type VoiceSessionStore,
} from "../../../src/modules/voiceChannel/public.js";
import { createVoiceTurnRunnerPort, observeVoiceTurn } from "../../../scripts/evalRunnerAdapter.js";
import { seedVoiceSettings } from "../../../scripts/runEvals.js";
import { createTestApp, issueTestSession } from "../../support/testApp.js";
import { VOICE_EVAL_AGENT_PROFILE, VOICE_EVAL_FALLBACK_LINE } from "./agent.js";
import { voiceEvalBrains, type VoiceEvalBrain } from "./scriptedBrains.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const ASSISTANT_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";

/**
 * Tiny, deterministic-only timing (`VoiceTurnService`'s `timing` override is documented "tests
 * only"): small enough that the turn-limit case resolves in well under a second, generous enough
 * that the other cases' immediate, un-awaited chat events never race it under CI load.
 */
const VOICE_EVAL_TIMING = {
  bridgeAfterMs: 500,
  bridgeAfterComposingIdleMs: 500,
  turnLimitMs: 700,
  replayWindowMs: 0,
};

const noopLogger = { info: (): void => undefined, warn: (): void => undefined };

const fakeSessions = (): VoiceSessionStore => ({
  findConversationId: async () => null,
  bind: async (_session, conversationId) => conversationId,
});

const noOperatorReplies = {
  claims: {
    claimPendingOperatorReplies: async () => [],
    markOperatorRepliesSpoken: async () => [],
    skipOperatorReplies: async () => [],
    releaseOperatorReplies: async () => [],
  },
  newClaimTurnId: () => "voice-eval-turn",
};

/**
 * Plays one case's `VoiceEvalChatScriptEvent`s as the turn's chat backend: a `status` becomes the
 * phase marker the turn policy reads, a `chunk` becomes streamed answer text, `done` closes the
 * turn (optionally with a hand-off, for the outcome case), and `stall` holds the stream open with
 * nothing further — never resolving, never advancing — so the turn's own limit, not a scripted
 * delay, is what ends the case built on it.
 */
const scriptedChat = (chatEvents: readonly VoiceEvalChatScriptEvent[]) => ({
  streamTurn: (_request: VoiceChatTurnRequest): AsyncIterable<ChatStreamEvent> => (async function* () {
    for (const event of chatEvents) {
      if (event.type === "status") {
        yield { type: "status", stage: event.stage } as unknown as ChatStreamEvent;
      } else if (event.type === "chunk") {
        yield { type: "chunk", text: event.text } as unknown as ChatStreamEvent;
      } else if (event.type === "done") {
        yield {
          type: "done",
          conversationId: CONVERSATION_ID,
          assistantMessageId: ASSISTANT_MESSAGE_ID,
          answer: "",
          activitySummary: { stages: [] },
          activityTrace: { events: [] },
          route: { type: "direct", reason: "social_only" },
          ...(event.handoff
            ? { ownership: { state: "human_owned", suppressed: false }, handoff: event.handoff }
            : {}),
        } as unknown as ChatStreamEvent;
      } else {
        // "stall": the generator suspends here forever. The turn's own limit ends the case, not
        // this await, and nothing waits on this promise once the case moves on.
        await new Promise<never>(() => undefined);
      }
    }
  })(),
});

/**
 * Plays a case's chat script: a fresh, real `VoiceTurnService` (the same policy, outcome
 * derivation and lines production runs) over the scripted chat backend above, a voice-enabled
 * agent profile, and no bound conversation, routine or teammate replies — a session's first turn.
 */
const runOnChatScript = async (
  evalCase: ConversationQualityCase,
  chatEvents: readonly VoiceEvalChatScriptEvent[],
): Promise<ConversationQualityObservedOutput> => {
  const service = new VoiceTurnService({
    sessions: fakeSessions(),
    chat: scriptedChat(chatEvents),
    agents: { findVoiceProfile: async () => VOICE_EVAL_AGENT_PROFILE },
    routines: { isRoutineActive: async () => false },
    ownership: { isHumanOwned: async () => false },
    operatorReplies: noOperatorReplies,
    logger: noopLogger,
    timing: VOICE_EVAL_TIMING,
  });
  const input = {
    session: { workspaceId: WORKSPACE_ID, agentId: AGENT_ID, vendor: "generic", sessionKey: `voice-eval-${evalCase.id}` },
    transport: "web" as const,
    utterance: conversationQualityCaseTurnText(evalCase),
    streamsSpeech: true,
  };
  const events = service.runTurn(input, new AbortController().signal);
  const voiceTurn = await observeVoiceTurn(events, VOICE_EVAL_FALLBACK_LINE);
  return { retrievedChunks: [], voiceTurn };
};

/**
 * Runs a case on a fresh test app over `brain`: a new workspace's default agent, voice turned on
 * by the live run's own `seedVoiceSettings`, and the turn driven through the app's composed
 * `voiceTurns` by the live run's own `createVoiceTurnRunnerPort`. Only the model is scripted; the
 * planner, retrieval, composer and voice turn policy are the app's own, on production timing.
 */
const runOnTestApp = async (
  evalCase: ConversationQualityCase,
  brain: VoiceEvalBrain,
): Promise<ConversationQualityObservedOutput> => {
  const { app, dependencies } = createTestApp(brain);
  const { workspaceId } = await issueTestSession(app, `voice-eval-${randomUUID()}@example.com`);
  const target = { workspaceId, agentId: (await dependencies.agentService.resolve(workspaceId)).id };
  await seedVoiceSettings({ agents: dependencies.agentRepository, agentSettings: dependencies.agentService }, target);
  const port = createVoiceTurnRunnerPort(dependencies.voiceTurns, {
    ...target,
    vendor: "generic",
    fallbackLine: VOICE_EVAL_FALLBACK_LINE,
  });
  return port.run(evalCase);
};

/**
 * The deterministic voice runner. A case with `voiceTurn.chatEvents` plays that script over a bare
 * `VoiceTurnService`; any other voice case runs on the test app over its scripted model in
 * `brains` (`scriptedBrains.ts`'s, unless a test hands in its own), so a regression in the
 * planner's quick-reply lane or the retrieval phase fails the case.
 */
export const createDeterministicVoiceTurnPort = (
  brains: Readonly<Record<string, VoiceEvalBrain>> = voiceEvalBrains,
): ConversationQualityRunnerPort => ({
  async run(evalCase) {
    const chatEvents = evalCase.voiceTurn?.chatEvents;
    if (chatEvents) {
      return runOnChatScript(evalCase, chatEvents);
    }
    const brain = brains[evalCase.id];
    if (evalCase.voiceTurn && brain) {
      return runOnTestApp(evalCase, brain);
    }
    throw new Error(
      `Case "${evalCase.id}" has neither a voiceTurn.chatEvents script nor a scripted model; it cannot run through the deterministic voice port.`,
    );
  },
});
