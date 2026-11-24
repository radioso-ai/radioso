import type { AgentContactRequestDelivery, AgentRecord } from "./domain.js";

/*
 * How an agent's `contact_human` notify skill sets its contact switch and delivery. One reader for
 * dispatch's contact delivery resolver, the dashboard's agent view and a conversation's release.
 */

/** Minimal view of a `contact_human` notify skill needed to resolve its delivery. */
interface ContactNotifySkillView {
  kind: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/**
 * Parses the delivery target carried on a `contact_human` notify skill
 * (`config.delivery`). Returns null when the skill has no delivery object, which
 * signals that the legacy agent-level delivery should be consulted instead. This
 * is the single reader shared with dispatch's contact delivery resolver so the
 * activation gate and the actual send cannot drift apart.
 */
export const readNotifyContactDelivery = (
  config?: Record<string, unknown>,
): AgentContactRequestDelivery | null => {
  const delivery = config?.delivery;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    return null;
  }
  const record = delivery as { recipientEmails?: unknown; webhook?: unknown };
  const recipientEmails = Array.isArray(record.recipientEmails)
    ? record.recipientEmails.filter((email): email is string => typeof email === "string")
    : [];
  const webhook =
    record.webhook && typeof record.webhook === "object" && !Array.isArray(record.webhook)
    && typeof (record.webhook as { url?: unknown }).url === "string"
      ? { url: (record.webhook as { url: string }).url }
      : null;
  return { recipientEmails, webhook };
};

/**
 * The effective contact delivery for an agent, mirroring dispatch precedence: an
 * enabled `contact_human` notify skill that carries its own `config.delivery` is
 * authoritative; otherwise the legacy agent-level `contactRequestDelivery`
 * applies. The workspace-owner fallback is not folded in — callers decide whether
 * an explicit destination exists via {@link hasConfiguredContactDestination}.
 */
export const resolveEffectiveContactDelivery = (
  notifySkill: ContactNotifySkillView | null | undefined,
  legacyDelivery: AgentContactRequestDelivery,
): AgentContactRequestDelivery => {
  if (notifySkill?.kind !== "notify" || !notifySkill.enabled) {
    return legacyDelivery;
  }
  return readNotifyContactDelivery(notifySkill.config) ?? legacyDelivery;
};

/**
 * The agent's contact switch and delivery as its `contact_human` notify skill sets them: the skill's
 * switch is the agent's, and its delivery wins over the agent-level one. An agent without such a
 * skill keeps its own. Applied to the live skill for the dashboard and to the release's skill for a
 * conversation, so the contact routine's gate reads the same skill a delivery would.
 */
export const withContactHumanSkill = <T extends Pick<AgentRecord, "contactRequestsEnabled" | "contactRequestDelivery">>(
  agent: T,
  notifySkill: ContactNotifySkillView | null | undefined,
): T => notifySkill?.kind === "notify"
  ? {
      ...agent,
      contactRequestsEnabled: notifySkill.enabled === true,
      contactRequestDelivery: resolveEffectiveContactDelivery(notifySkill, agent.contactRequestDelivery),
    }
  : agent;
