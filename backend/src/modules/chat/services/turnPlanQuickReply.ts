import type { ConversationTrace, SteeringRule } from "@radioso/conversation-contract";

import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import { GENERATION_SURFACE } from "../../../shared/domain/generationSurface.js";
import { addressesSurface } from "../../../shared/domain/steeringRule.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import {
  authoredMechanicsLine,
  plannerQuickReplyTextRejection,
  type PlannerTextRejection,
} from "./quickReplyWording.js";
import { TURN_PLAN_QUICK_REPLY_KINDS, type TurnPlanQuickReplyKind } from "./turnPlanService.js";

/**
 * Whose words a quick reply carries: one of the agent's authored lines, or the planner's own
 * text after it passed the format gate.
 */
export type QuickReplyWording = "authored" | "planner";

/** A reply the turn may send as its answer without composing one. */
export interface UsableQuickReply {
  kind: TurnPlanQuickReplyKind;
  text: string;
  wording: QuickReplyWording;
}

/** Why a quick reply the planner wrote was not sent (low-cardinality diagnostics). */
type QuickReplySkipReason =
  | "not_direct"
  | "request_present"
  | "open_question"
  | "rewrite_present"
  | "identity_question"
  | "routine_yield"
  | "answer_rules_differ"
  | `text_${PlannerTextRejection}`;


export type QuickReplyDecision =
  | { kind: "use"; quickReply: UsableQuickReply }
  | { kind: "skip"; plannedKind: TurnPlanQuickReplyKind; reason: QuickReplySkipReason }
  | { kind: "none" };

/**
 * True when the turn's answer steering is exactly the always-on directives the
 * planner wrote its reply under: every rule addressed to the answer is one of them,
 * and each of them reached the turn. A conditional directive that applies, guidance
 * from a skill or routine, or an always-on directive the runtime held back this turn
 * (an exclusion, a capability, a dependency) all make the sets differ.
 */
const answerRulesAreStandingDirectives = (
  rules: readonly SteeringRule[],
  standingDirectiveNames: readonly string[],
): boolean => {
  const standing = new Set(standingDirectiveNames);
  const applied = new Set<string>();
  for (const rule of rules) {
    if (!addressesSurface(rule.surfaces, GENERATION_SURFACE.ANSWER)) {
      continue;
    }
    if (
      rule.source !== "directive"
      || rule.condition !== undefined
      || rule.directiveName === undefined
      || !standing.has(rule.directiveName)
    ) {
      return false;
    }
    applied.add(rule.directiveName);
  }
  return applied.size === standing.size;
};

/**
 * Whether this direct turn's answer is the planner's quick reply. The planner wrote
 * the words; the host decides whether to send them, and every condition must hold:
 *
 * - The turn ran on a resolved plan. Pre-engine states never get one: an active,
 *   suspended, or claimed routine and a pending clarification bypass the planner,
 *   and a human-owned conversation leaves before answer selection.
 * - Both the plan and the interpreted turn are direct, and the plan's quick reply is
 *   not `none`.
 * - The planner's derivation fields, written before it chooses the kind, agree that the
 *   message is only mechanics: no request in it (`requestPresent`), nothing the assistant
 *   asked still open (`openQuestion`, so a short "ok" answers that question rather than
 *   closing the exchange), and no retrieval rewrite written, whichever route the plan chose.
 * - The turn is not an identity question; its answer needs the agent's identity,
 *   which the planner never sees.
 * - No routine yielded the turn to this answer (the composer leads back to its step).
 * - The turn's answer steering is exactly the always-on directives the planner wrote
 *   under, so an applying conditional directive sends the turn to the composer.
 *
 * Then the words: the agent's authored line for the mechanic in the reply's language when it
 * has one (rotated by how many replies the conversation already has), which is the lane's
 * guarantee; otherwise the planner's own text, only when it passes the format gate
 * ({@link plannerQuickReplyTextRejection}), which catches numbers, prices, and links, not
 * every invented fact.
 */
export const decideQuickReply = async (session: PreparedSession): Promise<QuickReplyDecision> => {
  const outcome = await session.turnPlan?.resolve(null);
  if (!outcome || outcome.status !== "planned") {
    return { kind: "none" };
  }
  const { plan } = outcome;
  const { quickReply } = plan;
  if (quickReply.kind === "none") {
    return { kind: "none" };
  }
  const skip = (reason: QuickReplySkipReason): QuickReplyDecision => ({
    kind: "skip",
    plannedKind: quickReply.kind,
    reason,
  });
  if (plan.route !== CHAT_TURN_ROUTE.DIRECT || session.turnRoute !== CHAT_TURN_ROUTE.DIRECT) {
    return skip("not_direct");
  }
  if (plan.requestPresent) {
    return skip("request_present");
  }
  if (plan.openQuestion) {
    return skip("open_question");
  }
  if (plan.rewritePresent) {
    return skip("rewrite_present");
  }
  if (plan.framing.isIdentityQuestion) {
    return skip("identity_question");
  }
  if (session.routineYield) {
    return skip("routine_yield");
  }
  if (!answerRulesAreStandingDirectives(session.directiveSteering?.rules ?? [], quickReply.standingDirectiveNames)) {
    return skip("answer_rules_differ");
  }
  const authored = authoredMechanicsLine({
    replies: session.agent.mechanicsReplies,
    kind: quickReply.kind,
    language: quickReply.language,
    rotation: session.history.filter((message) => message.role === "assistant").length,
  });
  if (authored) {
    return { kind: "use", quickReply: { kind: quickReply.kind, text: authored, wording: "authored" } };
  }
  const rejection = plannerQuickReplyTextRejection(quickReply.text);
  if (rejection) {
    return skip(`text_${rejection}`);
  }
  return { kind: "use", quickReply: { kind: quickReply.kind, text: quickReply.text, wording: "planner" } };
};

/** Where a turn's answer came from, when no compose-stage model call wrote it. */
interface PlannerReplySource {
  source: "turn_planning";
  quickReplyKind: TurnPlanQuickReplyKind;
  quickReplyWording: QuickReplyWording;
}

const REPLY_SOURCE_METADATA_KEY = "replySource";

const QUICK_REPLY_KINDS: ReadonlySet<string> = new Set(TURN_PLAN_QUICK_REPLY_KINDS);

/** Presentation or outcome metadata marking an answer the quick-reply lane sent. */
export const plannerReplySourceMetadata = (
  kind: TurnPlanQuickReplyKind,
  wording: QuickReplyWording,
): Record<string, unknown> => ({
  [REPLY_SOURCE_METADATA_KEY]: {
    source: "turn_planning",
    quickReplyKind: kind,
    quickReplyWording: wording,
  } satisfies PlannerReplySource,
});

export const plannerReplySourceOf = (metadata: Record<string, unknown> | undefined): PlannerReplySource | undefined => {
  const candidate = metadata?.[REPLY_SOURCE_METADATA_KEY];
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }
  const { source, quickReplyKind, quickReplyWording } = candidate as Record<string, unknown>;
  return source === "turn_planning"
    && typeof quickReplyKind === "string"
    && QUICK_REPLY_KINDS.has(quickReplyKind)
    && (quickReplyWording === "authored" || quickReplyWording === "planner")
    ? { source, quickReplyKind: quickReplyKind as TurnPlanQuickReplyKind, quickReplyWording }
    : undefined;
};

/**
 * Records on the compose stage that the planner wrote the answer, so the trace shows
 * a compose stage with no model call and says why. Other turns pass through unchanged.
 */
export const withPlannerReplySource = <T extends { trace: ConversationTrace }>(
  result: T,
  presentationMetadata: Record<string, unknown> | undefined,
): T => {
  const replySource = plannerReplySourceOf(presentationMetadata);
  if (!replySource) {
    return result;
  }
  return {
    ...result,
    trace: {
      ...result.trace,
      stages: result.trace.stages.map((stage) =>
        stage.kind === "compose"
          ? { ...stage, outputs: { ...(stage.outputs ?? {}), ...replySource } }
          : stage),
    },
  };
};
