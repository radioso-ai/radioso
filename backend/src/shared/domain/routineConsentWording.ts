import { canonicalContentHash } from "./canonicalContentHash.js";

/**
 * One language of a routine consent's wording, exactly as a visitor is shown it (#1544): the body
 * and the two answer labels. Shared by the routines module, which shows it, and the repository that
 * keeps every version shown as proof.
 */
export interface RoutineConsentWording {
  readonly locale: string;
  readonly body: string;
  readonly agreeLabel: string;
  readonly declineLabel: string;
}

/**
 * A wording version's id: a hash of exactly what the visitor saw, so the same wording is one version
 * wherever it is shown, and any changed character is another.
 */
export const routineConsentWordingVersionId = (wording: RoutineConsentWording): string =>
  canonicalContentHash({
    locale: wording.locale,
    body: wording.body,
    agreeLabel: wording.agreeLabel,
    declineLabel: wording.declineLabel,
  });
