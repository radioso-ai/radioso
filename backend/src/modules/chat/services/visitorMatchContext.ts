import { projectContextForMatching, type MatchContextProjection } from "../../context-variables/public.js";

import type { PreparedSession } from "./chatSessionPreparer.js";

/**
 * The turn's resolved visitor context, bounded and redacted for condition
 * matching. Shared by the two surfaces that judge directive conditions — the
 * staged directive matcher and the fused turn planner — so both see the same
 * context for the same turn.
 */
export const visitorMatchContext = (session: PreparedSession): MatchContextProjection =>
  projectContextForMatching(session.resolvedContext?.snapshot ?? {});
