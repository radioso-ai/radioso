import type { HandoffCollectedValue, HandoffOperatorNotification } from "./operatorNotification.js";

interface FormattedHandoffNotification {
  subject: string;
  /** Body lines, ready to join with a newline. The first line is the one-sentence headline. */
  lines: string[];
}

const HANDOFF_HEADLINE = "A conversation needs a human operator.";
const GENERIC_SUBJECT = "Conversation needs a human";

/**
 * Slot keys are identifiers (`arrival_date`, `needs-transfer`); the label only reshapes the
 * identifier for reading — separators become spaces and the first letter is upper-cased.
 */
const labelForSlotKey = (key: string): string => {
  const spaced = key.replace(/[_-]+/g, " ").trim();
  return spaced.length === 0 ? key : `${spaced[0].toUpperCase()}${spaced.slice(1)}`;
};

const renderCollectedValue = (value: HandoffCollectedValue): string =>
  typeof value === "boolean" ? (value ? "yes" : "no") : String(value);

const collectedLines = (collected: Record<string, HandoffCollectedValue> | undefined): string[] => {
  const entries = Object.entries(collected ?? {});
  if (entries.length === 0) {
    return [];
  }
  return [
    "",
    "Collected:",
    ...entries.map(([key, value]) => `  ${labelForSlotKey(key)}: ${renderCollectedValue(value)}`),
  ];
};

/**
 * One rendering of a handoff notice shared by every operator sink, so email, webhook text,
 * and Slack show the same routine name and collected values. Sinks append transport-specific
 * lines (such as the dashboard link) themselves.
 */
export const formatHandoffNotification = (
  notification: HandoffOperatorNotification,
): FormattedHandoffNotification => {
  const routineName = notification.routine?.name ?? null;
  const agentLine = notification.agentName
    ? `Agent: ${notification.agentName} (${notification.agentId})`
    : `Agent: ${notification.agentId}`;
  return {
    subject: routineName ? `${routineName}: needs a human` : GENERIC_SUBJECT,
    lines: [
      HANDOFF_HEADLINE,
      "",
      agentLine,
      ...(routineName ? [`Routine: ${routineName}`] : []),
      `Reason: ${notification.reason}`,
      `Conversation: ${notification.conversationId}`,
      `Workspace: ${notification.workspaceId}`,
      ...collectedLines(notification.collected),
    ],
  };
};
