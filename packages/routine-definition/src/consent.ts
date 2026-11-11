import { z } from "zod";

/**
 * Explicit consent a routine asks before it collects a sensitive slot (#1544), as an author writes
 * it on the routine. A consent names the slots it covers; Radioso asks it immediately before the
 * step that collects the first of them, so it cannot be put in the wrong place.
 *
 * The wording is the operator's own, shown verbatim, in one variant per language. Structure is
 * strict here (key, covered slots, at least one variant, the decline choice). Text is not: a blank
 * or oversized body or label, a bad locale, or a missing default-language variant is reported by
 * routine validation, so a half-written consent still saves as a draft.
 */

/** What the routine does when the visitor declines, or a consent cannot be asked. */
export const routineConsentDeclineChoices = ["continue", "handoff"] as const;

export const ROUTINE_CONSENT_LIMITS = {
  key: 120,
  slotKey: 120,
} as const;

// A consent key names the consent in compiled step ids (`consent:<key>:<stepId>`) and in validation
// locations (`consent:<key>.variants[0].body`), so it takes no dot, dash or colon.
const consentKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const slotKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** One language of a consent's wording: the body and the two answer labels, never trimmed or rewritten. */
const routineConsentVariantFields = {
  locale: z.string(),
  body: z.string(),
  agreeLabel: z.string(),
  declineLabel: z.string(),
};
const routineConsentVariantSchema = z.object(routineConsentVariantFields).strict();

const consentKeyField = z.string().trim().min(1).max(ROUTINE_CONSENT_LIMITS.key).regex(consentKeyPattern);
const consentSlotKeysField = z.array(z.string().trim().min(1).max(ROUTINE_CONSENT_LIMITS.slotKey).regex(slotKeyPattern))
  .min(1)
  .refine((keys) => new Set(keys).size === keys.length, "A consent names each slot it covers once");
const consentDeclineField = z.enum(routineConsentDeclineChoices);

export const routineConsentSchema = z.object({
  key: consentKeyField,
  slotKeys: consentSlotKeysField,
  variants: z.array(routineConsentVariantSchema).min(1),
  onDecline: consentDeclineField,
}).strict();

/**
 * A consent as a stored routine row reads back: every rule of {@link routineConsentSchema} on the
 * fields it knows, with fields it does not know dropped rather than refused. A field a later
 * version writes then survives a rollback to this one, while a broken known field still fails the
 * read.
 */
export const routineConsentStoredSchema = z.object({
  key: consentKeyField,
  slotKeys: consentSlotKeysField,
  variants: z.array(z.object(routineConsentVariantFields)).min(1),
  onDecline: consentDeclineField,
});

/** Every state an authoring surface may hold a consent in mid-edit. */
export const routineConsentEditingSchema = z.object({
  key: z.string().trim().max(ROUTINE_CONSENT_LIMITS.key),
  slotKeys: z.array(z.string().trim().max(ROUTINE_CONSENT_LIMITS.slotKey)),
  variants: z.array(routineConsentVariantSchema),
  onDecline: z.enum(routineConsentDeclineChoices),
}).strict();

export type RoutineConsentVariant = z.infer<typeof routineConsentVariantSchema>;
export type RoutineConsentDefinition = z.infer<typeof routineConsentSchema>;
