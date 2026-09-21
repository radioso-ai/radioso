import type { SlackSuggestedPrompt } from "../../../slack/public.js";

/**
 * The conversation starters the Slack plugin offers in the agent pane. Declared here
 * so the plugin depends on the shape it needs, not on whichever chat service
 * supplies it; composition binds the chat module's reader to it.
 */
export interface SlackStarterPromptsPort {
  listStarterPrompts(input: { workspaceId: string; agentId: string }): Promise<ReadonlyArray<{ label: string }>>;
}

// Slack caps a session title at 200 characters; 60 keeps the pane's sidebar readable.
const SESSION_TITLE_MAX_LENGTH = 60;
// assistant.threads.setSuggestedPrompts accepts at most four prompts.
const SUGGESTED_PROMPTS_MAX = 4;

// Counted in code points so an emoji on the boundary is kept whole rather than split into a lone surrogate.
const truncate = (text: string, maxLength: number): string => {
  const characters = Array.from(text);
  return characters.length > maxLength ? `${characters.slice(0, maxLength).join("")}…` : text;
};

/** The user's own first words, collapsed to one line, as the session's sidebar title. */
export const sessionTitleFromMessage = (text: string): string =>
  truncate(text.replace(/\s+/gu, " ").trim(), SESSION_TITLE_MAX_LENGTH);

/** Chip labels as Slack prompt pairs: the label is both what is shown and what is sent. */
export const toSuggestedPrompts = (prompts: ReadonlyArray<{ label: string }>): SlackSuggestedPrompt[] =>
  prompts.slice(0, SUGGESTED_PROMPTS_MAX).map((prompt) => ({
    title: truncate(prompt.label, SESSION_TITLE_MAX_LENGTH),
    message: prompt.label,
  }));
