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

type SupersededProfileColumn = "monthly_indexed_byte_limit" | "stored_document_limit";

/**
 * Profile caps an earlier catalog seeded, per column and plan. The seed only inserts profiles, so a
 * catalog change reaches an existing profile only through the migrator, and only while the profile
 * still holds one of these values: a profile an operator edited in the console keeps its own.
 */
export const SUPERSEDED_PROFILE_SEEDS: Readonly<
  Record<SupersededProfileColumn, Readonly<Partial<Record<string, readonly number[]>>>>
> = {
  monthly_indexed_byte_limit: { comet: [20_971_520], satellite: [41_943_040], planet: [209_715_200] },
  stored_document_limit: { comet: [2_000], satellite: [10_000], planet: [50_000] },
};

export const SUPERSEDED_PROFILE_COLUMNS = Object.keys(SUPERSEDED_PROFILE_SEEDS) as SupersededProfileColumn[];

/** The current catalog value a superseded column moves to. */
export const seedValueForColumn = (seed: UsageLimitProfileSeed, column: SupersededProfileColumn): number =>
  column === "monthly_indexed_byte_limit" ? seed.monthlyIndexedByteLimit : seed.storedDocumentLimit;
