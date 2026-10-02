import { SLOT_REFERENCE_PATTERN } from "@radioso/routine-definition";

import type { HandoffCollectedValue, RoutineEndingOperatorNotification } from "./operatorNotification.js";

interface FormattedRoutineEndingNotification {
  subject: string;
  /** Body lines, ready to join with a newline. The first line is the one-sentence headline. */
  lines: string[];
  /** The authored notice text with collected values substituted; `null` where the author wrote none. */
  notice: { subject: string | null; intro: string | null };
}

/** The text a notice falls back to when its author wrote none, per kind of ending. */
const DEFAULT_TEXT: Record<RoutineEndingOperatorNotification["kind"], {
  headline: string;
  routineSubject: (routineName: string) => string;
  genericSubject: string;
}> = {
  handoff: {
    headline: "A conversation needs a human operator.",
    routineSubject: (routineName) => `${routineName}: needs a human`,
    genericSubject: "Conversation needs a human",
  },
  completion: {
    headline: "A conversation completed a routine.",
    routineSubject: (routineName) => `${routineName}: completed`,
    genericSubject: "Routine completed",
  },
};

/** What a reference to a value the routine did not collect renders as: the notice still goes out. */
const MISSING_VALUE = "—";

const LINE_BREAKS = /[\r\n]+/gu;

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

const collectedBlock = (collected: Record<string, HandoffCollectedValue> | undefined): string[] | null => {
  const entries = Object.entries(collected ?? {});
  if (entries.length === 0) {
    return null;
  }
  return [
    "Collected:",
    ...entries.map(([key, value]) => `  ${labelForSlotKey(key)}: ${renderCollectedValue(value)}`),
  ];
};

/**
 * Substitutes `{{slot.<key>}}` with the collected value. The notice is plain text, so nothing is
 * escaped; a subject is a single header line, so a value's line breaks become spaces there.
 */
const renderTemplate = (
  template: string | undefined,
  collected: Record<string, HandoffCollectedValue> | undefined,
  options: { singleLine: boolean },
): string | null => {
  if (!template) {
    return null;
  }
  const rendered = template.replace(SLOT_REFERENCE_PATTERN, (_token, key: string) => {
    const value = collected?.[key];
    const text = value === undefined ? "" : renderCollectedValue(value).trim();
    const shown = text.length > 0 ? text : MISSING_VALUE;
    return options.singleLine ? shown.replace(LINE_BREAKS, " ") : shown;
  });
  return options.singleLine ? rendered.replace(LINE_BREAKS, " ").trim() : rendered;
};

/**
 * The notice's last section: the entry page, when known. Always rendered as its own section
 * (even empty) so a single blank line separates it from whatever precedes it — the sink's
 * `Open:` link follows directly after, with no blank line of its own.
 */
const footerLines = (notification: RoutineEndingOperatorNotification): string[] => [
  ...(notification.conversation?.entryPageUrl ? [`Entry page: ${notification.conversation.entryPageUrl}`] : []),
];

/**
 * One rendering of a routine-ending notice shared by every operator sink, so email, webhook text,
 * and Slack show the same subject, routine name, and collected values. The authored subject
 * replaces the default, the authored intro follows the headline, and every collected value is
 * always listed after the details so a template can never hide what the routine gathered. Sinks
 * append transport-specific lines (such as the dashboard link) themselves.
 *
 * The body reads as plain prose for non-technical staff, not a log: no agent, routine, reason,
 * conversation, workspace, or channel identifiers. Those still travel on the webhook JSON
 * (`notification.reason`, `notification.routine`, …), just not in this human-readable text.
 * The headline/intro, collected values, and footer sections join with one blank line each; the
 * collected section is left out entirely when there are no values, so a notice missing them never
 * prints a stray blank. The footer section always reserves its separating blank line, even with
 * no entry page, because a sink's `Open:` link follows directly after it.
 */
export const formatRoutineEndingNotification = (
  notification: RoutineEndingOperatorNotification,
): FormattedRoutineEndingNotification => {
  const defaults = DEFAULT_TEXT[notification.kind];
  const routineName = notification.routine?.name ?? null;
  const subject = renderTemplate(notification.notice?.subject, notification.collected, { singleLine: true });
  const intro = renderTemplate(notification.notice?.intro, notification.collected, { singleLine: false });
  const headline = [defaults.headline, ...(intro ? [intro] : [])];
  const collected = collectedBlock(notification.collected);
  const sections: string[][] = [headline, ...(collected ? [collected] : []), footerLines(notification)];
  return {
    subject: subject || (routineName ? defaults.routineSubject(routineName) : defaults.genericSubject),
    lines: sections.flatMap((section, index) => (index === 0 ? section : ["", ...section])),
    notice: { subject, intro },
  };
};
