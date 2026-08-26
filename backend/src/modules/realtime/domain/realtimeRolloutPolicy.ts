export interface RealtimeRolloutPolicy {
  allows(input: { accountId: string }): boolean;
}

export const createRealtimeRolloutPolicy = (input: {
  mode: "disabled" | "internal" | "allowlist" | "default-on";
  accountIds: readonly string[];
}): RealtimeRolloutPolicy => {
  const allowed = new Set(input.accountIds);
  return {
    allows: ({ accountId }) => input.mode === "default-on" || (["allowlist", "internal"].includes(input.mode) && allowed.has(accountId)),
  };
};
