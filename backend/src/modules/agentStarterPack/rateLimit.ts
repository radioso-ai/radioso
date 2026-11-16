/**
 * Durable abuse-control policies for the starter pack endpoints, in the same shape and with the
 * same subject keys as the agent wizard's (`modules/agentWizard/routes.ts`). Drafting makes
 * several model calls, so it shares the wizard analysis budget of five per hour.
 */
export const STARTER_PACK_DRAFT_RATE_LIMIT = {
  scope: "agent_starter_pack.draft",
  limit: 5,
  windowMs: 3_600_000,
  blockMs: 60_000,
} as const;

/** Same budget as the wizard's create step: applying is cheap, but each apply writes several rows. */
export const STARTER_PACK_APPLY_RATE_LIMIT = {
  scope: "agent_starter_pack.apply",
  limit: 10,
  windowMs: 3_600_000,
  blockMs: 60_000,
} as const;

/** One budget per signed-in user, and one shared budget for API callers, within a workspace. */
export const starterPackRateLimitSubjectKey = (locals: Record<string, unknown>): string => {
  const workspaceId = typeof locals.workspaceId === "string" ? locals.workspaceId : "unknown";
  const userId = typeof locals.userId === "string" ? locals.userId : null;
  return userId ? `${workspaceId}:user:${userId}` : `${workspaceId}:api`;
};
