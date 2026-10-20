import type { ChatGateway } from "../../../src/modules/chat/contracts/index.js";
import { TurnPlanCoordinator } from "../../../src/modules/chat/services/turnPlanCoordinator.js";
import { TurnPlanService } from "../../../src/modules/chat/services/turnPlanService.js";
import type { TurnPlanGatewayFactory } from "../../../src/shared/infra/llm/turnPlanGateway.js";
import type { createTestApp } from "../../support/testApp.js";

/**
 * The model a deterministic voice case's turn runs on: the test app's real planner, retrieval and
 * composer, with the planner's call and the composer's answer scripted. The voice turn policy runs
 * on its production timing, so what bridges is what the chat turn reports, as in a real call.
 */
export type VoiceEvalBrain = Pick<NonNullable<Parameters<typeof createTestApp>[0]>, "chatGateway" | "turnPlanCoordinator">;

/**
 * How long the slow composer takes: past the composing-idle bridge
 * (`VOICE_BEHAVIOR.bridgeAfterComposingIdleMs`, 400 ms), well inside the stall bridge (2.5 s) and
 * the turn limit (10 s), so a turn the composer answers bridges on its composing phase alone.
 */
const SLOW_COMPOSER_MS = 1_000;

const THANKS_REPLY = "You're very welcome!";

const composerAfter = (delayMs: number, text: string): ChatGateway => {
  const answer = async (): Promise<string> => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return text;
  };
  return {
    answer,
    async *streamAnswer() {
      yield await answer();
    },
  };
};

/** A planner that plans every turn as a direct answer: the planner's own quick reply, or the composer's. */
const plannerAnswering = (quickReply?: { kind: "thanks"; text: string }): TurnPlanCoordinator => {
  const factory: TurnPlanGatewayFactory = {
    create: async () => ({
      complete: async () => ({
        text: JSON.stringify({
          route: "direct",
          isIdentityQuestion: false,
          intentTopic: null,
          rewrite: null,
          responseLanguage: "English",
          responseLanguageTag: "en",
          requestPresent: quickReply === undefined,
          openQuestion: false,
          quickReply: quickReply ? { ...quickReply, language: "en" } : { kind: "none", language: null, text: "" },
        }),
      }),
    }),
  };
  return new TurnPlanCoordinator(new TurnPlanService(factory));
};

/** The scripted models a voice case's `voiceTurn.scriptedBrain` names. */
export const voiceEvalBrains: Readonly<Record<string, VoiceEvalBrain>> = {
  // No planner: the staged path routes the question to retrieval, which reports `searching`. The
  // composer answers at once, so only that phase can bridge the turn.
  "searching-then-answer": {
    chatGateway: composerAfter(0, "Partial refunds are available within 14 days of booking."),
  },
  // The planner's quick reply is the whole turn. The composer is slow, so a thank-you that left
  // the quick-reply lane would bridge on its composing phase and fail the case.
  "thanks-quick-reply": {
    chatGateway: composerAfter(SLOW_COMPOSER_MS, THANKS_REPLY),
    turnPlanCoordinator: plannerAnswering({ kind: "thanks", text: THANKS_REPLY }),
  },
};

/** The quick-reply case's model with the lane bypassed: the planner writes no quick reply, so the slow composer answers. */
export const voiceEvalBrainWithoutQuickReply: VoiceEvalBrain = {
  chatGateway: composerAfter(SLOW_COMPOSER_MS, THANKS_REPLY),
  turnPlanCoordinator: plannerAnswering(),
};
