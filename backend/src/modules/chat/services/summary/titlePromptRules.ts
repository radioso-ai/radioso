/**
 * The title-writing rules shared by both prompts that can produce a conversation
 * title (issue #1129): the combined summary+title regeneration
 * (`chat/conversation-summary.md`, used once the conversation is long enough for a
 * real summary) and the early, title-only prompt (`chat/conversation-early-title.md`,
 * used once per conversation lifetime before that point). Kept as one exported
 * constant, rendered into both templates via `{{title_rules}}`, so the two never
 * drift into two different definitions of what a good title looks like.
 */
export const CONVERSATION_TITLE_RULES = `- Write the title in the same language the conversation uses.
- Name the topic in at most about 8 words — what the conversation is about, not who is in it or which channel it came from.
- Plain text: no markdown, no surrounding quotes, no trailing punctuation.
- If the conversation is too short or unclear to name a topic yet, return an empty string rather than guessing.`;
