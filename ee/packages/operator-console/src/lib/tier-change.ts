import type { AccountUsageSummary, UsageLimitProfile } from "./staff-auth-api";

type OverLimitResource =
  | "monthlyConversations"
  | "monthlyAnswers"
  | "storedDocuments"
  | "storedIndexedBytes"
  | "monthlyIndexedBytes";

const meteredResources = {
  monthlyAnswers: "monthlyAnswerLimit",
  storedDocuments: "storedDocumentLimit",
  storedIndexedBytes: "storedIndexedByteLimit",
  monthlyIndexedBytes: "monthlyIndexedByteLimit",
} as const satisfies Record<string, keyof UsageLimitProfile>;

type MeteredResource = keyof typeof meteredResources;

type TierLimits = Pick<UsageLimitProfile, (typeof meteredResources)[MeteredResource] | "monthlyConversationLimit">;

type Meters = Pick<AccountUsageSummary, MeteredResource | "monthlyConversations">;

/**
 * Resources where the target tier caps below what the account has already used.
 *
 * Which meter to compare is the *target* tier's question, not the account's. A tier
 * carrying a conversation limit leaves its answer cap dormant, so comparing against that
 * cap would warn about a limit the backend never enforces; and skipping the answer check
 * because the *account* happens to be conversation-metered would drop a real warning when
 * moving down onto an answer-metered tier.
 */
export const overLimitResources = (usage: Meters, tier: TierLimits): OverLimitResource[] => {
  const conversationLimit = tier.monthlyConversationLimit;
  const breached: OverLimitResource[] = (Object.keys(meteredResources) as MeteredResource[])
    .filter((resource) => {
      if (resource === "monthlyAnswers" && conversationLimit !== null) {
        return false;
      }
      const limit = tier[meteredResources[resource]];
      return typeof limit === "number" && usage[resource].used > limit;
    });

  // An account arriving from an answer-metered tier has no conversation count to compare,
  // so moving onto a catalog tier warns once the account has one.
  if (usage.monthlyConversations
    && conversationLimit !== null
    && usage.monthlyConversations.used > conversationLimit) {
    breached.unshift("monthlyConversations");
  }
  return breached;
};
