export interface RealtimeRolloutPolicy {
  allows(input: { accountId: string }): boolean;
}

export const createRealtimeRolloutPolicy = (input: {
  mode: "disabled" | "internal" | "allowlist" | "default-on";
  accountIds: readonly string[];
  internalAccountIds?: readonly string[];
}): RealtimeRolloutPolicy => {
  const allowed = new Set(input.accountIds);
  const internal = new Set(input.internalAccountIds ?? []);
  return {
    allows: ({ accountId }) => input.mode === "default-on" || (input.mode === "allowlist" && allowed.has(accountId)) || (input.mode === "internal" && internal.has(accountId)),
  };
};
