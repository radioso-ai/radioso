import type { ConversationTrace } from "@radioso/conversation-contract";

import { CHAT_TURN_ROUTE } from "../../../shared/domain/chatTurnRoute.js";
import type { ActivityTrace } from "../../retrieval/public.js";
import type { ChatRoute } from "../types/chatResponses.js";
import { RETRIEVAL_TRACE_LEAF, capabilitySubTrace } from "./chatTraceLeaves.js";
import type { PreparedSession } from "./chatSessionPreparer.js";
import { attachCapabilitySubTrace } from "./turnTraceEnvelope.js";

const DISPATCH_STAGE_ID_PREFIX = "dispatch:";

/**
 * Hang the retrieval activity trace on the spine's last dispatch stage: the skill whose outcome
 * was rendered, which is the fallback when a bound skill did not answer. Found by kind, so it
 * is robust to the presentation skill name being reclassified (grounded-miss).
 */
export const attachRetrievalActivityTrace = (
  spine: ConversationTrace,
  activityTrace: ActivityTrace,
): ConversationTrace => {
  const dispatchStage = spine.stages.filter((stage) => stage.kind === "skill_dispatch").at(-1);
  if (!dispatchStage) {
    return spine;
  }
  const skillName = typeof dispatchStage.outputs?.skillName === "string"
    ? dispatchStage.outputs.skillName
    : dispatchStage.id.startsWith(DISPATCH_STAGE_ID_PREFIX)
      ? dispatchStage.id.slice(DISPATCH_STAGE_ID_PREFIX.length)
      : dispatchStage.id;
  return attachCapabilitySubTrace(spine, {
    skillName,
    subTrace: capabilitySubTrace(RETRIEVAL_TRACE_LEAF, activityTrace),
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRetrievalSkillName = (value: unknown): boolean =>
  typeof value === "string" && value.startsWith("retrieval.");

const traceIncludesRetrievalSkillDispatch = (trace?: ConversationTrace): boolean =>
  trace?.stages.some((stage) => {
    if (isRetrievalSkillName(stage.outputs?.skillName)) {
      return true;
    }

    if (stage.subTrace?.namespace !== "routine" || !isRecord(stage.subTrace.payload)) {
      return false;
    }

    const steps = stage.subTrace.payload.steps;
    return Array.isArray(steps) && steps.some((step) =>
      isRecord(step)
      && step.event === "skill_dispatched"
      && isRetrievalSkillName(step.skillName),
    );
  }) ?? false;

/** How the turn was routed, as its reply and audit report it: retrieval when any skill it ran retrieved. */
export const getChatTurnRoute = (session: PreparedSession, engineTrace?: ConversationTrace): ChatRoute => {
  if (traceIncludesRetrievalSkillDispatch(engineTrace)) {
    return {
      type: "retrieval",
      reason: "evidence_required",
    };
  }

  if (session.turnRoute !== CHAT_TURN_ROUTE.RETRIEVAL) {
    return {
      type: "direct",
      reason: session.turnFraming?.isIdentityQuestion
        ? "assistant_identity"
        : "social_only",
    };
  }

  return {
    type: "retrieval",
    reason: "evidence_required",
  };
};
