import { renderPromptTemplate } from "../../../../shared/infra/prompts/promptLoader.js";

/**
 * Renders the rolling conversation summary (#866) as a labelled prompt section,
 * or an empty string when there is no summary. Shared by every injection point
 * (turn interpretation, grounded answer, direct answer) so an absent or blank
 * summary adds zero prompt overhead and the label is identical everywhere.
 * The section text itself is a runtime prompt and lives under backend/prompts/
 * (same rule as the steering block).
 */
export const renderConversationSummarySection = (summary?: string | null): string => {
  const trimmed = summary?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  return renderPromptTemplate("chat/conversation-summary-section.md", { summary: trimmed });
};
