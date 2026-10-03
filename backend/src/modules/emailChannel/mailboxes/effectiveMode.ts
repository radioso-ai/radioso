export type EngagementMode = "operator_only" | "draft" | "auto";

interface EngagementPolicy {
  mode: EngagementMode;
  enabled: boolean;
}

const AUTONOMY: Readonly<Record<EngagementMode, number>> = { operator_only: 0, draft: 1, auto: 2 };

/**
 * Execution authority for a delivery (research B16): the lower-autonomy mode of the policy in
 * force when the provider event was accepted and the policy in force now, enabled only if both
 * are. A policy change can therefore narrow what in-flight mail may do, never widen it.
 */
export const effectiveEngagementMode = (accepted: EngagementPolicy, current: EngagementPolicy): EngagementPolicy => ({
  mode: AUTONOMY[accepted.mode] <= AUTONOMY[current.mode] ? accepted.mode : current.mode,
  enabled: accepted.enabled && current.enabled,
});
