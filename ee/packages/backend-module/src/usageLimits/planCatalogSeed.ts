import type { Plan } from "@radioso/plan-catalog";

interface UsageLimitProfileSeed {
  key: string;
  displayName: string;
  monthlyAnswerLimit: number | null;
  storedDocumentLimit: number;
  storedIndexedByteLimit: number;
  monthlyIndexedByteLimit: number;
  monthlyConversationLimit: number;
  repliesPerConversation: number;
}

/**
 * Maps a `@radioso/plan-catalog` plan onto `ee_usage_limit_profiles` columns. Catalog plans meter
 * conversations, never the legacy per-answer counter, so `monthlyAnswerLimit` is always null here.
 */
export const profileSeedFromPlan = (plan: Plan, repliesPerConversation: number): UsageLimitProfileSeed => ({
  key: plan.id,
  displayName: plan.name,
  monthlyAnswerLimit: null,
  storedDocumentLimit: plan.documents,
  storedIndexedByteLimit: plan.storedBytes,
  monthlyIndexedByteLimit: plan.monthlyIndexedBytes,
  monthlyConversationLimit: plan.monthlyConversations,
  repliesPerConversation,
});
