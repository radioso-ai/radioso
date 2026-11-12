import { collectedSlotsByStep } from '@radioso/routine-definition'

import type { ExactContentItem, RoutineValidationDiagnostic } from './api-types'
import { addVariant, removeVariant, updateChipLabel, updateVariantBody } from './exact-greeting-editor'
import { blockSegmentsToInstruction, type RoutineBlockDoc } from './routine-prose'

/**
 * Pure editor transitions for a routine's consents (#1544): the explicit consent a visitor gives
 * before a sensitive field is collected. A consent names the sensitive fields it covers, carries
 * its wording per language (a body, an agree label and a decline label, shown to visitors
 * verbatim), and says what the routine does when the visitor declines.
 *
 * Knows the block document and the exact-words variant rules it reuses; knows nothing of React or
 * HTTP. Wording is never trimmed or rewritten here: what the operator types is what visitors read.
 */

export type RoutineConsentDraft = NonNullable<RoutineBlockDoc['consents']>[number]
export type ConsentDeclineChoice = RoutineConsentDraft['onDecline']
type ConsentVariantField = 'locale' | 'body' | 'agreeLabel' | 'declineLabel'

const AGREE = 'agree'
const DECLINE = 'decline'

export const consentsOf = (doc: Pick<RoutineBlockDoc, 'consents'>): RoutineConsentDraft[] => doc.consents ?? []

const sensitiveFieldKeys = (doc: Pick<RoutineBlockDoc, 'information'>): string[] =>
  doc.information.filter((slot) => slot.sensitivity === 'sensitive').map((slot) => slot.key)

const mapConsent = (doc: RoutineBlockDoc, key: string, edit: (consent: RoutineConsentDraft) => RoutineConsentDraft): RoutineBlockDoc => ({
  ...doc,
  consents: consentsOf(doc).map((consent) => (consent.key === key ? edit(consent) : consent)),
})

/** Rewrites the covered fields of every consent, leaving a document without consents as it was. */
const mapCoveredFields = (doc: RoutineBlockDoc, edit: (slotKeys: string[]) => string[]): RoutineBlockDoc =>
  doc.consents === undefined
    ? doc
    : { ...doc, consents: doc.consents.map((consent) => ({ ...consent, slotKeys: edit(consent.slotKeys) })) }

const nextConsentKey = (doc: RoutineBlockDoc, base: string): string => {
  const used = new Set(consentsOf(doc).map((consent) => consent.key))
  if (!used.has(base)) return base
  let index = 2
  while (used.has(`${base}_${index}`)) index += 1
  return `${base}_${index}`
}

/**
 * A consent over one sensitive field, named after it, with blank wording in the agent's default
 * language (the one language every consent needs) and the routine continuing without the field
 * when a visitor declines. A field that is not sensitive needs no consent, so nothing changes.
 */
export const addConsent = (doc: RoutineBlockDoc, slotKey: string, agentDefaultLocale: string): RoutineBlockDoc => {
  if (!sensitiveFieldKeys(doc).includes(slotKey)) return doc
  const consent: RoutineConsentDraft = {
    key: nextConsentKey(doc, slotKey),
    slotKeys: [slotKey],
    onDecline: 'continue',
    variants: [{ locale: agentDefaultLocale, body: '', agreeLabel: '', declineLabel: '' }],
  }
  return { ...doc, consents: [...consentsOf(doc), consent] }
}

export const removeConsent = (doc: RoutineBlockDoc, key: string): RoutineBlockDoc => ({
  ...doc,
  consents: consentsOf(doc).filter((consent) => consent.key !== key),
})

/** Only a sensitive field can be covered; uncovering may leave a consent covering nothing yet. */
export const setConsentCoversField = (doc: RoutineBlockDoc, key: string, slotKey: string, covers: boolean): RoutineBlockDoc => {
  if (covers && !sensitiveFieldKeys(doc).includes(slotKey)) return doc
  return mapConsent(doc, key, (consent) => ({
    ...consent,
    slotKeys: covers
      ? (consent.slotKeys.includes(slotKey) ? consent.slotKeys : [...consent.slotKeys, slotKey])
      : consent.slotKeys.filter((candidate) => candidate !== slotKey),
  }))
}

export const setConsentDecline = (doc: RoutineBlockDoc, key: string, onDecline: ConsentDeclineChoice): RoutineBlockDoc =>
  mapConsent(doc, key, (consent) => ({ ...consent, onDecline }))

// A consent's wording is exact content whose two chips are its answer labels, the same view the
// backend validates it through, so the exact-words variant transitions apply to it unchanged.
const asExactContent = (consent: RoutineConsentDraft): ExactContentItem => ({
  chips: [AGREE, DECLINE],
  variants: consent.variants.map((variant) => ({
    locale: variant.locale,
    body: variant.body,
    chipLabels: { [AGREE]: variant.agreeLabel, [DECLINE]: variant.declineLabel },
  })),
})

const editWording = (doc: RoutineBlockDoc, key: string, edit: (item: ExactContentItem) => ExactContentItem): RoutineBlockDoc =>
  mapConsent(doc, key, (consent) => ({
    ...consent,
    variants: edit(asExactContent(consent)).variants.map((variant) => ({
      locale: variant.locale,
      body: variant.body,
      agreeLabel: variant.chipLabels[AGREE] ?? '',
      declineLabel: variant.chipLabels[DECLINE] ?? '',
    })),
  }))

export const addConsentLanguage = (doc: RoutineBlockDoc, key: string, locale: string): RoutineBlockDoc =>
  editWording(doc, key, (item) => addVariant(item, locale))

/** A consent always keeps one language, so its last one stays. */
export const removeConsentLanguage = (doc: RoutineBlockDoc, key: string, locale: string): RoutineBlockDoc =>
  editWording(doc, key, (item) => {
    const next = removeVariant(item, locale)
    return next.variants.length > 0 ? next : item
  })

export const setConsentBody = (doc: RoutineBlockDoc, key: string, locale: string, body: string): RoutineBlockDoc =>
  editWording(doc, key, (item) => updateVariantBody(item, locale, body))

export const setConsentAgreeLabel = (doc: RoutineBlockDoc, key: string, locale: string, label: string): RoutineBlockDoc =>
  editWording(doc, key, (item) => updateChipLabel(item, locale, AGREE, label))

export const setConsentDeclineLabel = (doc: RoutineBlockDoc, key: string, locale: string, label: string): RoutineBlockDoc =>
  editWording(doc, key, (item) => updateChipLabel(item, locale, DECLINE, label))

/** The keys of the consents that cover a field. More than one is a validation error to fix. */
export const consentsCoveringField = (doc: Pick<RoutineBlockDoc, 'consents'>, slotKey: string): string[] =>
  consentsOf(doc).filter((consent) => consent.slotKeys.includes(slotKey)).map((consent) => consent.key)

/** The sensitive fields a consent may cover, and which other consent already covers each. */
export const consentFieldChoices = (doc: RoutineBlockDoc, key: string): Array<{ key: string; covered: boolean; coveredBy: string | null }> =>
  sensitiveFieldKeys(doc).map((slotKey) => {
    const covering = consentsCoveringField(doc, slotKey)
    return { key: slotKey, covered: covering.includes(key), coveredBy: covering.find((candidate) => candidate !== key) ?? null }
  })

/** Sensitive fields no consent covers yet. Publishing refuses each of them. */
export const uncoveredSensitiveFields = (doc: RoutineBlockDoc): string[] =>
  sensitiveFieldKeys(doc).filter((slotKey) => consentsCoveringField(doc, slotKey).length === 0)

/**
 * The consents asked before each step, by the rule the compiler places them with: a consent goes
 * immediately before the step that collects one of its fields, and the first step that names a
 * field is the one that collects it.
 */
export const consentKeysAskedBeforeStep = (doc: RoutineBlockDoc): Map<string, string[]> => {
  const consents = consentsOf(doc)
  const asked = new Map<string, string[]>()
  if (consents.length === 0) return asked
  const collected = collectedSlotsByStep(doc.steps.map((step, ordinal) => ({
    stableStepId: step.stableStepId,
    kind: step.kind,
    instruction: blockSegmentsToInstruction(step.instruction),
    ordinal,
  })))
  for (const [stepId, slotKeys] of collected) {
    const keys = consents.filter((consent) => consent.slotKeys.some((slotKey) => slotKeys.includes(slotKey))).map((consent) => consent.key)
    if (keys.length > 0) asked.set(stepId, keys)
  }
  return asked
}

/** Rewrites a renamed field in every consent that covers it. */
export const renameFieldInConsents = (doc: RoutineBlockDoc, from: string, to: string): RoutineBlockDoc =>
  mapCoveredFields(doc, (slotKeys) => slotKeys.map((slotKey) => (slotKey === from ? to : slotKey)))

/** Drops a field from every consent, as removing it or marking it not sensitive does. */
export const dropFieldFromConsents = (doc: RoutineBlockDoc, slotKey: string): RoutineBlockDoc =>
  mapCoveredFields(doc, (slotKeys) => slotKeys.filter((candidate) => candidate !== slotKey))

// --- Validation findings, placed by the location format `consentValidation.ts` writes:
// `consent:<key>`, `consent:<key>.variants`, `consent:<key>.variants[i].<field>`,
// `consent:<key>.slotKeys.<field>` and `consent:<key>.steps.<stepId>`. ---

export type ConsentIssues = {
  consent: RoutineValidationDiagnostic[]
  fields: RoutineValidationDiagnostic[]
  steps: RoutineValidationDiagnostic[]
  variantFields: Array<{ index: number; field: ConsentVariantField; diagnostic: RoutineValidationDiagnostic }>
}

const variantFieldPattern = /^variants\[(\d+)\]\.(locale|body|agreeLabel|declineLabel)$/u

export const consentIssues = (diagnostics: readonly RoutineValidationDiagnostic[], key: string): ConsentIssues => {
  const issues: ConsentIssues = { consent: [], fields: [], steps: [], variantFields: [] }
  const prefix = `consent:${key}`
  for (const diagnostic of diagnostics) {
    const { location } = diagnostic
    if (location !== prefix && !location.startsWith(`${prefix}.`)) continue
    const field = location.slice(prefix.length + 1)
    const variant = variantFieldPattern.exec(field)
    if (variant) issues.variantFields.push({ index: Number(variant[1]), field: variant[2] as ConsentVariantField, diagnostic })
    else if (field.startsWith('slotKeys.')) issues.fields.push(diagnostic)
    else if (field.startsWith('steps.')) issues.steps.push(diagnostic)
    else issues.consent.push(diagnostic)
  }
  return issues
}

export const issuesForConsentVariant = (issues: ConsentIssues, index: number, field: ConsentVariantField): RoutineValidationDiagnostic[] =>
  issues.variantFields.filter((issue) => issue.index === index && issue.field === field).map((issue) => issue.diagnostic)

const consentVariantFieldCopy: Record<ConsentVariantField, string> = {
  locale: 'Choose a valid language this consent does not use yet.',
  body: 'Write the wording: plain text, up to 8,000 characters, no {{…}} references.',
  agreeLabel: 'Write a label of up to 80 characters, different from the decline label.',
  declineLabel: 'Write a label of up to 80 characters, different from the agree label.',
}

const consentDiagnosticCopy: Partial<Record<RoutineValidationDiagnostic['code'], string>> = {
  consent_missing_default_variant: "Add wording in the agent's default language.",
  consent_key_duplicate: 'Another consent uses this key.',
  consent_slot_unknown: 'Covers a field this routine does not collect.',
  consent_slot_not_sensitive: 'Covers a field that is not sensitive.',
}

/**
 * A finding as a short line beside the part of the consent it is about. `stepLabel` names a step
 * the way the document numbers it.
 */
export const consentDiagnosticText = (
  diagnostic: RoutineValidationDiagnostic,
  options: { field?: ConsentVariantField; stepLabel?: (stepId: string) => string } = {},
): string => {
  if (diagnostic.code === 'consent_text_invalid' && options.field) return consentVariantFieldCopy[options.field]
  if (diagnostic.code === 'consent_step_mixes_fields' || diagnostic.code === 'consent_step_needs_default_exit') {
    const stepId = diagnostic.location.slice(diagnostic.location.indexOf('.steps.') + '.steps.'.length)
    const step = options.stepLabel?.(stepId) ?? `step ${stepId}`
    return diagnostic.code === 'consent_step_mixes_fields'
      ? `Continuing on decline needs ${step} to ask for nothing else. Ask the rest in its own step, or hand off.`
      : `Continuing on decline needs ${step} to have a default exit. Add one, or hand off.`
  }
  return consentDiagnosticCopy[diagnostic.code] ?? diagnostic.message
}
