import type { GenerationSurface } from "../../../../shared/domain/generationSurface.js";
import type { PreparedSession } from "../chatSessionPreparer.js";

/**
 * Records that a generator actually produced visitor-facing output from its steering
 * block. Matching alone is not rendering: the host calls this only after the
 * generator's final filtering has left something visible to the visitor.
 *
 * Two pieces of bookkeeping hang off that one moment, and they are deliberately
 * different in reach:
 *
 * - `renderedSurfaces` covers **every** matched rule, so the turn trace can tell a
 *   repeatable directive that reached the visitor from one whose generator never ran.
 * - the pending firing capture covers **only** once/cooldown directives, which are
 *   the only ones carrying a budget to spend.
 *
 * Recording just the second would leave a repeatable suggestion-only directive
 * reading as applied on a turn where its generator produced nothing.
 */
export const recordDirectiveSurfaceRendered = (
  session: Pick<PreparedSession, "directiveStateStore" | "directiveSteering">,
  surface: GenerationSurface,
): void => {
  const steering = session.directiveSteering;
  if (!steering) {
    return;
  }
  if (!steering.renderedSurfaces?.includes(surface)) {
    steering.renderedSurfaces = [...(steering.renderedSurfaces ?? []), surface];
  }
  const pendingBySurface = steering.pendingSurfaceFirings;
  const pending = pendingBySurface?.[surface];
  if (!pendingBySurface || !pending?.length) {
    return;
  }
  session.directiveStateStore?.capture(pending);
  delete pendingBySurface[surface];
};
