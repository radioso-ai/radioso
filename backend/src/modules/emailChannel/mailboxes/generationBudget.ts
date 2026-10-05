/** The mailbox generation budget's window (FR-023, research B8): one hour, fixed, anchored at its first generation. */
const GENERATION_WINDOW_MS = 60 * 60 * 1000;

/**
 * What a review asking to generate got: a charge on the mailbox's window, the charge its revision
 * already made on an earlier attempt, or none because the window is full.
 */
export type GenerationReservation = "reserved" | "already_reserved" | "exhausted";

interface MailboxGenerationWindow {
  hourlyGenerationBudget: number;
  /** When the current window's first generation was charged; null before any. */
  generationWindowStartedAt: Date | null;
  generationWindowCount: number;
}

/** A window that started after this instant is still open at `at`; one that started at it or before has rolled. */
export const generationWindowOpenAfter = (at: Date): Date => new Date(at.getTime() - GENERATION_WINDOW_MS);

/** Whether the mailbox's window is open at `at` and full, so accepted mail goes to a person (FR-023). */
export const isGenerationBudgetExhausted = (mailbox: MailboxGenerationWindow, at: Date): boolean =>
  mailbox.generationWindowStartedAt !== null
  && mailbox.generationWindowStartedAt.getTime() > generationWindowOpenAfter(at).getTime()
  && mailbox.generationWindowCount >= mailbox.hourlyGenerationBudget;
