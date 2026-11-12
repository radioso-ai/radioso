import type { Routine } from "@radioso/conversation-contract";

import { routineConsentWordingOf, type RoutineConsentWording } from "../../../shared/domain/routineConsentWording.js";
import type { RoutineDefinition } from "../domain.js";

/**
 * Where a compiled routine keeps the wording of its consents (#1544). The engine's compiled
 * consent names its slots and decline choice only; the words a visitor is shown are the host's,
 * carried in the routine's own metadata from the revision it was compiled from.
 */
const CONSENT_WORDING_METADATA_KEY = "consentWording";

/** The metadata entry carrying every language of each consent, by key; none for a routine without consents. */
export const consentWordingMetadata = (
  consents: RoutineDefinition["consents"],
): Record<string, Record<string, RoutineConsentWording[]>> =>
  consents && consents.length > 0
    ? { [CONSENT_WORDING_METADATA_KEY]: Object.fromEntries(consents.map((consent) => [consent.key, consent.variants])) }
    : {};

/** Every language a compiled routine carries for consent `key`, as written; empty when it carries none. */
export const consentWordingVariants = (routine: Routine, key: string): RoutineConsentWording[] => {
  const byKey = routine.metadata?.[CONSENT_WORDING_METADATA_KEY];
  const variants = byKey && typeof byKey === "object" ? (byKey as Record<string, unknown>)[key] : undefined;
  return Array.isArray(variants)
    ? variants.flatMap((variant) => routineConsentWordingOf(variant) ?? [])
    : [];
};
