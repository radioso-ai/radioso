/**
 * The operator-facing outcome bucket for a conversation row — the server-side twin of
 * `ConversationOutcome`/`deriveConversationOutcome` in `frontend/lib/conversation-outcome.ts`.
 * `HistoryItemsRepository`'s `outcome` filter derives the same three buckets in SQL so the
 * All-lens toolbar's outcome filter narrows to exactly the rows that would show that chip.
 */
export type ConversationOutcomeFilter = "in_progress" | "completed" | "handed_off";

/**
 * A conversation with no human ownership counts as "in progress" within this window of its
 * last activity. Must stay numerically equal to the frontend twin's
 * `IN_PROGRESS_WINDOW_MS = 10 * 60 * 1000` (`frontend/lib/conversation-outcome.ts`) — minutes,
 * not milliseconds, because the SQL side adds it to `now()` as a Postgres interval.
 */
export const CONVERSATION_OUTCOME_IN_PROGRESS_WINDOW_MINUTES = 10;
