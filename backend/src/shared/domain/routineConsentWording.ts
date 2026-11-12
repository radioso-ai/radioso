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

const isText = (value: unknown): value is string => typeof value === "string";

/**
 * A wording as a routine turn carries it back unread (`RoutineConsentEvent.wording` is the host's
 * own value), narrowed to its four fields; null for anything else.
 */
export const routineConsentWordingOf = (value: unknown): RoutineConsentWording | null => {
  if (!value || typeof value !== "object") return null;
  const { locale, body, agreeLabel, declineLabel } = value as Record<string, unknown>;
  return isText(locale) && isText(body) && isText(agreeLabel) && isText(declineLabel)
    ? { locale, body, agreeLabel, declineLabel }
    : null;
};
