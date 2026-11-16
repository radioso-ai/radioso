// How many `.cause` hops past the original error a chain walk looks at. A generic turn-
// level wrapper (`RoutineActivationFailure`, a plain `Error` with no provider shape of
// its own) carries the real error one hop down; this stays small because a cause chain
// is attacker- or library-controlled depth, not something to walk unbounded.
const MAX_CAUSE_CHAIN_DEPTH = 3;

/** The error itself, then up to {@link MAX_CAUSE_CHAIN_DEPTH} hops of `.cause`, cycle-safe. */
export const causeChainNodes = (error: unknown): unknown[] => {
  const nodes: unknown[] = [];
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth <= MAX_CAUSE_CHAIN_DEPTH; depth += 1) {
    if (current === null || current === undefined || visited.has(current)) {
      break;
    }
    visited.add(current);
    nodes.push(current);
    current = typeof current === "object" && "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return nodes;
};
