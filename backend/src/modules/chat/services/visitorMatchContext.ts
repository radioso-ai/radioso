import { projectContextForMatching, type MatchContextProjection } from "../../context-variables/public.js";
import { callerKindForSourceChannel } from "../../../shared/domain/conversationSource.js";

import type { PreparedSession } from "./chatSessionPreparer.js";

/**
 * Reserved key for a fact Radioso states about the turn rather than one an operator defined.
 * Prefixed so it cannot collide with — or be shadowed by — a workspace's own context variable,
 * and applied after the projection so the reserved meaning wins if a workspace picks the name.
 */
export const CALLER_KIND_MATCH_KEY = "radioso_caller_kind";

/**
 * The turn's resolved visitor context, bounded and redacted for condition
 * matching. Shared by the two surfaces that judge directive conditions — the
 * staged directive matcher and the fused turn planner — so both see the same
 * context for the same turn.
 *
 * Caller kind rides here rather than in the matcher's `turnContext` because only the matcher reads
 * that: when a fused turn plan exists the planner's classifications are used and the matcher is
 * never called, so a fact carried only on `turnContext` would be absent from every normal turn.
 * It is always present, including for people. A lever an operator can only aim at agents, and only
 * by reasoning about a missing key, is not a lever they can write a condition against.
 */
export const visitorMatchContext = (session: PreparedSession): MatchContextProjection => {
  const projection = projectContextForMatching(session.resolvedContext?.snapshot ?? {});
  return {
    ...projection,
    context: {
      ...projection.context,
      // Falling back to the channel derivation rather than emitting `undefined`: the stored kind is
      // required on a conversation record, and a key with no value is worse than the same answer
      // computed a second way.
      [CALLER_KIND_MATCH_KEY]: session.conversation.callerKind
        ?? callerKindForSourceChannel(session.conversation.sourceChannel),
    },
  };
};
