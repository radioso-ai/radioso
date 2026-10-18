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

/**
 * Monthly indexing caps an earlier catalog seeded into each plan's profile. A seeded profile still
 * at one of these values was never edited in the console, so the migrator moves it to the current
 * catalog value; a profile an operator edited keeps its own.
 */
export const SUPERSEDED_MONTHLY_INDEXED_BYTE_SEEDS: Readonly<Partial<Record<string, readonly number[]>>> = {
  comet: [20_971_520],
  satellite: [41_943_040],
  planet: [209_715_200],
};

