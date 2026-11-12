/**
 * One routine consent decision as a conversation's consents read it (#1544): the proof, never a
 * value or a reply. Shared by the privacy module, which lists and withdraws records, and the
 * repository that reads them.
 */
export interface RoutineConsentRecord {
  id: string;
  routineId: string;
  consentKey: string;
  /** The slots the consent covered when it was decided, which a withdrawal erases. */
  slotKeys: string[];
  decision: "granted" | "declined";
  method: "button" | "reply";
  /** Declined because the visitor's replies stayed unclear after the consent was asked twice. */
  defaulted: boolean;
  locale: string;
  channel: string | null;
  wordingVersionId: string;
  /** The wording exactly as the visitor was shown it. */
  wording: { body: string; agreeLabel: string; declineLabel: string };
  decidedAt: Date;
  withdrawnAt: Date | null;
}
