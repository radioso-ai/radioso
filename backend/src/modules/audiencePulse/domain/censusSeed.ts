import { createHash } from "node:crypto";

/**
 * Derives the deterministic seed `@radioso/census` clusters with (algorithm.md,
 * "Determinism"): a hash of the workspace, the window bounds, and the sorted set of
 * facet ids actually going into the clustering call. Same input -> same seed -> same
 * output; a changed input set (a newly extracted facet, a re-embedded one) correctly
 * changes the seed and therefore the result.
 *
 * `facetIds` is the id set of the items handed to `computeCensus`, not the wider
 * eligible-question population -- a question excluded as unclassified because its
 * facet is missing or stale contributes nothing to what is actually clustered, so it
 * must not perturb the seed either.
 */
export const deriveCensusSeed = (input: {
  workspaceId: string;
  windowStart: Date;
  windowEnd: Date;
  facetIds: readonly string[];
}): string => {
  const payload = JSON.stringify({
    workspaceId: input.workspaceId,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    facetIds: [...input.facetIds].sort(),
  });
  return createHash("sha256").update(payload).digest("hex");
};
