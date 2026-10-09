/**
 * Which rule picked a contact or notice destination, in precedence order: the notify skill the
 * request names, the agent's `contact_human` skill (or that skill turned off, which sends nothing),
 * the agent's contact settings, the workspace owner or admin, or nobody at all.
 */
export const contactDeliveryRoutes = [
  "named_skill",
  "contact_human",
  "contact_human_off",
  "agent_setting",
  "workspace_owner",
  "none",
] as const;

export type ContactDeliveryRoute = (typeof contactDeliveryRoutes)[number];
