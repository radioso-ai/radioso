import type { RoutineValidationCode } from "@radioso/routine-definition";

import { validateExactContentItem, type ExactContentItem } from "../../shared/domain/exactContent.js";
import type { RoutineDefinition } from "./domain.js";

type ConsentDefinition = NonNullable<RoutineDefinition["consents"]>[number];

interface ConsentDiagnostic {
  code: Extract<RoutineValidationCode, `consent_${string}`>;
  location: string;
  message: string;
}

const AGREE_CHIP = "agree";
const DECLINE_CHIP = "decline";

/**
 * A consent's wording as exact content: each variant's body, with its two answer labels as the
 * chips `agree` and `decline`. Consent wording is shown verbatim the way exact words are, so it is
 * held to the same rules (a valid, unrepeated locale; a body and labels that are neither blank nor
 * too long; no `{{…}}` reference, since nothing is substituted into it) by the same validator.
 */
const consentAsExactContent = (consent: ConsentDefinition): ExactContentItem => ({
  chips: [AGREE_CHIP, DECLINE_CHIP],
  variants: consent.variants.map((variant) => ({
    locale: variant.locale,
    body: variant.body,
    chipLabels: { [AGREE_CHIP]: variant.agreeLabel, [DECLINE_CHIP]: variant.declineLabel },
  })),
});

const consentFieldOf = (exactContentPath: string): string | null => {
  const match = /^(variants\[\d+\])\.(locale|body|chipLabels\.(agree|decline))$/u.exec(exactContentPath);
  if (!match) return null;
  const label = match[3];
  return `${match[1]}.${label === undefined ? match[2] : `${label}Label`}`;
};

// Labels a visitor could not tell apart are no choice. Compared as a reader would see them.
const sameLabel = (left: string, right: string): boolean =>
  left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

const wordingDiagnostics = (consent: ConsentDefinition, agentDefaultLocale: string): ConsentDiagnostic[] => {
  const diagnostics: ConsentDiagnostic[] = [];
  const validation = validateExactContentItem(consentAsExactContent(consent), {
    agentDefaultLocale,
    availableReferenceKeys: new Set(),
  });
  for (const issue of validation.ok ? [] : validation.issues) {
    if (issue.code === "missing_default_variant") {
      diagnostics.push({
        code: "consent_missing_default_variant",
        location: `consent:${consent.key}.variants`,
        message: `consent missing default variant: consent "${consent.key}" needs wording in the agent's default language "${agentDefaultLocale}".`,
      });
      continue;
    }
    // An agent whose own default locale is unusable is not the consent's to fix.
    const field = consentFieldOf(issue.path);
    if (field) {
      diagnostics.push({
        code: "consent_text_invalid",
        location: `consent:${consent.key}.${field}`,
        message: `consent text invalid: consent "${consent.key}" ${field}: ${issue.message}.`,
      });
    }
  }
  consent.variants.forEach((variant, index) => {
    if (variant.agreeLabel.trim().length > 0 && sameLabel(variant.agreeLabel, variant.declineLabel)) {
      diagnostics.push({
        code: "consent_text_invalid",
        location: `consent:${consent.key}.variants[${index}].declineLabel`,
        message: `consent text invalid: consent "${consent.key}" variants[${index}] offers the same label to agree and to decline.`,
      });
    }
  });
  return diagnostics;
};

/**
 * The authoring rules for a routine's consents (#1544): every covered slot is one the routine
 * declares and marks sensitive, no slot is covered twice, keys are unique, and each consent has
 * usable wording in the agent's default language. The validator runs them only when it knows that
 * language, which the compile path never passes, so a published revision always compiles.
 */
export const consentDiagnostics = (
  definition: Pick<RoutineDefinition, "slots" | "consents">,
  agentDefaultLocale: string,
): ConsentDiagnostic[] => {
  const consents = definition.consents ?? [];
  const slotByKey = new Map(definition.slots.map((slot) => [slot.key, slot]));
  const diagnostics: ConsentDiagnostic[] = [];

  const seenKeys = new Set<string>();
  const duplicateKeys = new Set<string>();
  const coveringCount = new Map<string, number>();
  for (const consent of consents) {
    if (seenKeys.has(consent.key)) duplicateKeys.add(consent.key);
    seenKeys.add(consent.key);
    for (const slotKey of new Set(consent.slotKeys)) {
      coveringCount.set(slotKey, (coveringCount.get(slotKey) ?? 0) + 1);
    }
  }
  for (const key of duplicateKeys) {
    diagnostics.push({
      code: "consent_key_duplicate",
      location: `consent:${key}`,
      message: `consent key duplicate: more than one consent uses the key "${key}"; each consent needs its own.`,
    });
  }

  for (const consent of consents) {
    for (const slotKey of consent.slotKeys) {
      const slot = slotByKey.get(slotKey);
      if (!slot) {
        diagnostics.push({
          code: "consent_slot_unknown",
          location: `consent:${consent.key}.slotKeys.${slotKey}`,
          message: `consent slot unknown: consent "${consent.key}" covers "${slotKey}", which this routine does not declare.`,
        });
      } else if (slot.sensitivity !== "sensitive") {
        diagnostics.push({
          code: "consent_slot_not_sensitive",
          location: `consent:${consent.key}.slotKeys.${slotKey}`,
          message: `consent slot not sensitive: consent "${consent.key}" covers "${slotKey}", which is not marked sensitive.`,
        });
      }
    }
  }
  for (const [slotKey, count] of coveringCount) {
    if (count > 1) {
      diagnostics.push({
        code: "consent_slot_covered_twice",
        location: `slot:${slotKey}`,
        message: `consent slot covered twice: "${slotKey}" is covered by ${count} consents; one consent covers each slot.`,
      });
    }
  }

  for (const consent of consents) {
    diagnostics.push(...wordingDiagnostics(consent, agentDefaultLocale));
  }
  return diagnostics;
};

const CONSENT_LOCATION_PATTERN = /^consent:([A-Za-z_][A-Za-z0-9_]*)(?:\.(.*))?$/u;

const consentLocationOf = (location: string): { key: string; field: string | null } | null => {
  const match = CONSENT_LOCATION_PATTERN.exec(location);
  return match ? { key: match[1], field: match[2] ?? null } : null;
};

const slotLocationOf = (location: string): string | null =>
  location.startsWith("slot:") ? location.slice("slot:".length) : null;

/**
 * Messages a transport may show for each consent finding: they name the consent, the slot or the
 * field from the structural location (schema-shaped identifiers), never the wording.
 */
export const safeConsentValidationMessages: Record<ConsentDiagnostic["code"], (location: string) => string> = {
  consent_slot_unknown: (location) => {
    const consent = consentLocationOf(location);
    const slotKey = consent?.field?.replace(/^slotKeys\./u, "");
    return consent && slotKey
      ? `Consent "${consent.key}" covers "${slotKey}", which this routine does not collect. Remove it from the consent or add the field.`
      : "A consent covers a field this routine does not collect.";
  },
  consent_slot_not_sensitive: (location) => {
    const consent = consentLocationOf(location);
    const slotKey = consent?.field?.replace(/^slotKeys\./u, "");
    return consent && slotKey
      ? `Consent "${consent.key}" covers "${slotKey}", which is not marked sensitive. Mark the field sensitive or remove it from the consent.`
      : "A consent covers a field that is not marked sensitive.";
  },
  consent_slot_covered_twice: (location) => {
    const slotKey = slotLocationOf(location);
    return slotKey
      ? `Field "${slotKey}" is covered by more than one consent. Keep it in one.`
      : "A field is covered by more than one consent.";
  },
  consent_key_duplicate: (location) => {
    const consent = consentLocationOf(location);
    return consent ? `More than one consent uses the key "${consent.key}".` : "More than one consent uses the same key.";
  },
  consent_missing_default_variant: (location) => {
    const consent = consentLocationOf(location);
    return consent
      ? `Consent "${consent.key}" needs wording in the agent's default language.`
      : "A consent needs wording in the agent's default language.";
  },
  consent_text_invalid: (location) => {
    const consent = consentLocationOf(location);
    return consent?.field
      ? `Consent "${consent.key}" has unusable text in ${consent.field}: it is blank, too long, repeats a language, holds a {{…}} reference, or offers the same label twice.`
      : "A consent's wording is blank, too long, or otherwise unusable.";
  },
};
