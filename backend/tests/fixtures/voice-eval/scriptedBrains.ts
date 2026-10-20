import type { ChatGateway } from "../../../src/modules/chat/contracts/index.js";
import { TurnPlanCoordinator } from "../../../src/modules/chat/services/turnPlanCoordinator.js";
import { TurnPlanService } from "../../../src/modules/chat/services/turnPlanService.js";
import type { TurnPlanGatewayFactory } from "../../../src/shared/infra/llm/turnPlanGateway.js";
import type { createTestDependencies } from "../../support/testApp.js";

/**
 * The model a deterministic voice case's turn runs on: a test composition's real planner,
 * retrieval and composer, with the planner's call and the composer's answer scripted, and the
 * voice turn policy on `SCRIPTED_BRAIN_TIMING`. What bridges is what the chat turn reports, as in
 * a real call.
 */
export type VoiceEvalBrain = Pick<
  NonNullable<Parameters<typeof createTestDependencies>[0]>,
  "chatGateway" | "turnPlanCoordinator" | "voiceTurnTiming"
>;

/**
 * The voice turn timing every scripted brain runs on: the composing-idle bridge at 5 s, the stall
 * bridge and the turn limit at 30 s. A loaded runner never stalls that long between two events of
 * one turn, so a case asserts what the chat turn reported, not the clock. The cases that are about
 * the clock (the turn limit) play a chat script on timing the harness sets, instead.
 */
const SCRIPTED_BRAIN_TIMING = { bridgeAfterComposingIdleMs: 5_000, bridgeAfterMs: 30_000, turnLimitMs: 30_000 };

/**
 * How long the slow composer takes: past the composing-idle bridge, well inside the stall bridge
 * and the turn limit, so a turn the composer answers bridges on its composing phase alone.
 */
const SLOW_COMPOSER_MS = SCRIPTED_BRAIN_TIMING.bridgeAfterComposingIdleMs + 1_000;

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

const REFUND_ANSWER = "Partial refunds are available within 14 days of booking.";

/** A well-formed retrieval rewrite, so a plan that routes to retrieval parses. */
const RETRIEVAL_REWRITE = {
  resolutionNote: null,
  turnKind: "fresh_subject",
  proposedActiveSubject: null,
  relatedEntities: [],
  rewrittenQuery: "cancellation policy partial refunds",
  semanticQuery: "what the cancellation policy says about partial refunds",
  lexicalQuery: "cancellation policy partial refund",
  queryShape: "policy_answer",
  temporalQueryMode: "none",
  retrievalSubqueries: [],
  unresolved: false,
  confidence: 0.9,
};

/** What the scripted planner decides for every turn it plans. */
type ScriptedPlan =
  | { route: "retrieval" }
  | { route: "direct"; quickReply?: { kind: "thanks"; text: string } };

/** The planner's reply for `plan`, as the model writes it. */
export const scriptedPlanText = (plan: ScriptedPlan): string => {
  const quickReply = plan.route === "direct" ? plan.quickReply : undefined;
  return JSON.stringify({
    route: plan.route,
    isIdentityQuestion: false,
    intentTopic: null,
    rewrite: plan.route === "retrieval" ? RETRIEVAL_REWRITE : null,
    responseLanguage: "English",
    responseLanguageTag: "en",
    requestPresent: quickReply === undefined,
    openQuestion: false,
    quickReply: quickReply ? { ...quickReply, language: "en" } : { kind: "none", language: null, text: "" },
  });
};

/** A planner that plans every turn the same: a retrieval, the composer's direct answer, or its own quick reply. */
const plannerPlanning = (plan: ScriptedPlan): TurnPlanCoordinator => {
  const factory: TurnPlanGatewayFactory = {
    create: async () => ({ complete: async () => ({ text: scriptedPlanText(plan) }) }),
  };
  return new TurnPlanCoordinator(new TurnPlanService(factory));
};

/** The scripted models a voice case's `voiceTurn.scriptedBrain` names. */
export const voiceEvalBrains: Readonly<Record<string, VoiceEvalBrain>> = {
  // The planner routes the question to retrieval, which reports `searching`. The composer answers
  // at once, so only that phase can bridge the turn.
  "searching-then-answer": {
    chatGateway: composerAfter(0, REFUND_ANSWER),
    turnPlanCoordinator: plannerPlanning({ route: "retrieval" }),
    voiceTurnTiming: SCRIPTED_BRAIN_TIMING,
  },
  // The planner's quick reply is the whole turn. The composer is slow, so a thank-you that left
  // the quick-reply lane would bridge on its composing phase and fail the case.
  "thanks-quick-reply": {
    chatGateway: composerAfter(SLOW_COMPOSER_MS, THANKS_REPLY),
    turnPlanCoordinator: plannerPlanning({ route: "direct", quickReply: { kind: "thanks", text: THANKS_REPLY } }),
    voiceTurnTiming: SCRIPTED_BRAIN_TIMING,
  },
};

/**
 * The timing the lane-bypass brain runs on: the composing-idle bridge at 1 s, so the case fails in
 * under three seconds. Its composer answers at 2.5 s, well past the bridge, so what fails the case
 * is the bridge alone.
 */
const LANE_BYPASS_TIMING = { ...SCRIPTED_BRAIN_TIMING, bridgeAfterComposingIdleMs: 1_000 };

/** The quick-reply case's model with the lane bypassed: the planner writes no quick reply, so a slow composer answers. */
export const voiceEvalBrainWithoutQuickReply: VoiceEvalBrain = {
  chatGateway: composerAfter(2_500, THANKS_REPLY),
  turnPlanCoordinator: plannerPlanning({ route: "direct" }),
  voiceTurnTiming: LANE_BYPASS_TIMING,
};

/** The searching case's model with the search gone: the planner routes direct and the composer answers at once, so nothing bridges. */
export const voiceEvalBrainAnsweringDirect: VoiceEvalBrain = {
  chatGateway: composerAfter(0, REFUND_ANSWER),
  turnPlanCoordinator: plannerPlanning({ route: "direct" }),
  voiceTurnTiming: SCRIPTED_BRAIN_TIMING,
};
