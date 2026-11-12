import { describe, expect, it } from 'vitest'

import type { RoutineValidationDiagnostic } from '@/lib/api'
import {
  addConsent,
  addConsentLanguage,
  consentDiagnosticText,
  consentFieldChoices,
  consentIssues,
  consentKeysAskedBeforeStep,
  consentsCoveringField,
  removeConsent,
  removeConsentLanguage,
  setConsentAgreeLabel,
  setConsentBody,
  setConsentCoversField,
  setConsentDecline,
  setConsentDeclineLabel,
  uncoveredSensitiveFields,
} from '@/lib/routine-consent-editor'
import { draftFromBlockDoc, routineToBlockDoc } from '@/lib/routine-prose'

// A booking routine: a name, then two sensitive fields asked together, then an allergy question.
const booking = () => {
  const result = routineToBlockDoc({
    name: 'Book a table',
    activation: { triggerDescription: 'A guest wants to book a table', priority: 0 },
    slots: [
      { stableSlotId: 'guest_name', key: 'guest_name', type: 'text', required: true, description: null, ordinal: 0 },
      { stableSlotId: 'dietary', key: 'dietary', type: 'text', required: true, description: null, ordinal: 1, sensitivity: 'sensitive' },
      { stableSlotId: 'allergies', key: 'allergies', type: 'text', required: false, description: null, ordinal: 2, sensitivity: 'sensitive' },
    ],
    steps: [
      { stableStepId: 'ask_name', kind: 'chat', instruction: 'Ask for {{slot.guest_name}}.', toolRef: null, actionType: null, ordinal: 0, metadata: {} },
      { stableStepId: 'ask_diet', kind: 'chat', instruction: 'Ask about {{slot.dietary}}.', toolRef: null, actionType: null, ordinal: 1, metadata: {} },
      { stableStepId: 'ask_allergies', kind: 'chat', instruction: 'Ask about {{slot.allergies}}, then repeat {{slot.dietary}}.', toolRef: null, actionType: null, ordinal: 2, metadata: {} },
    ],
    transitions: [
      { fromStep: 'ask_name', toRef: 'ask_diet', guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 },
      { fromStep: 'ask_diet', toRef: 'ask_allergies', guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 1 },
      { fromStep: 'ask_allergies', toRef: 'booked', guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 2 },
    ],
    terminals: [{ stableStepId: 'booked', kind: 'complete', instruction: 'Confirm the booking.', ordinal: 0 }],
  })
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join(', '))
  return result.doc
}

// The booking routine with a diagnosis code a skill looks up: sensitive, so notices mask it, and
// asked of the guest by no chat step.
const bookingLookingUpDiagnosis = () => {
  const result = routineToBlockDoc({
    ...draftFromBlockDoc(booking()),
    slots: [
      ...draftFromBlockDoc(booking()).slots,
      { stableSlotId: 'diagnosis_code', key: 'diagnosis_code', type: 'text', required: false, description: null, ordinal: 3, sensitivity: 'sensitive' },
    ],
    terminals: [{ stableStepId: 'booked', kind: 'complete', instruction: 'Confirm the booking, noting {{slot.diagnosis_code}}.', ordinal: 0 }],
  })
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join(', '))
  return result.doc
}

describe('authoring a consent', () => {
  it('adds a consent over a sensitive field, with blank wording in the agent default language, continuing on decline', () => {
    const doc = addConsent(booking(), 'dietary', 'it')

    expect(doc.consents).toEqual([{
      key: 'dietary',
      slotKeys: ['dietary'],
      onDecline: 'continue',
      variants: [{ locale: 'it', body: '', agreeLabel: '', declineLabel: '' }],
    }])
    expect(draftFromBlockDoc(doc).consents).toEqual(doc.consents)
  })

  it('gives a second consent its own key and refuses one over a field that is not sensitive', () => {
    const doc = addConsent(addConsent(booking(), 'dietary', 'en'), 'dietary', 'en')

    expect(doc.consents?.map((consent) => consent.key)).toEqual(['dietary', 'dietary_2'])
    expect(addConsent(booking(), 'guest_name', 'en')).toEqual(booking())
  })

  it('removes a consent and leaves the others as written', () => {
    const doc = addConsent(addConsent(booking(), 'dietary', 'en'), 'allergies', 'en')

    expect(removeConsent(doc, 'dietary').consents?.map((consent) => consent.key)).toEqual(['allergies'])
  })

  it('covers and uncovers sensitive fields only', () => {
    const doc = addConsent(booking(), 'dietary', 'en')

    expect(setConsentCoversField(doc, 'dietary', 'allergies', true).consents?.[0]?.slotKeys).toEqual(['dietary', 'allergies'])
    expect(setConsentCoversField(doc, 'dietary', 'guest_name', true)).toEqual(doc)
    expect(setConsentCoversField(doc, 'dietary', 'dietary', false).consents?.[0]?.slotKeys).toEqual([])
  })

  it('offers each sensitive field, saying which consent already covers it', () => {
    const doc = addConsent(addConsent(booking(), 'dietary', 'en'), 'allergies', 'en')

    expect(consentFieldChoices(doc, 'dietary')).toEqual([
      { key: 'dietary', covered: true, coveredBy: null, askedOfVisitor: true },
      { key: 'allergies', covered: false, coveredBy: 'allergies', askedOfVisitor: true },
    ])
    expect(consentsCoveringField(doc, 'allergies')).toEqual(['allergies'])
  })

  it('never covers a sensitive field no step asks the visitor for, and offers it only as unavailable', () => {
    const doc = addConsent(bookingLookingUpDiagnosis(), 'dietary', 'en')

    expect(addConsent(bookingLookingUpDiagnosis(), 'diagnosis_code', 'en')).toEqual(bookingLookingUpDiagnosis())
    expect(setConsentCoversField(doc, 'dietary', 'diagnosis_code', true)).toEqual(doc)
    expect(consentFieldChoices(doc, 'dietary')).toEqual([
      { key: 'dietary', covered: true, coveredBy: null, askedOfVisitor: true },
      { key: 'allergies', covered: false, coveredBy: null, askedOfVisitor: true },
      { key: 'diagnosis_code', covered: false, coveredBy: null, askedOfVisitor: false },
    ])
  })

  it('sets what happens when a visitor declines', () => {
    const doc = setConsentDecline(addConsent(booking(), 'dietary', 'en'), 'dietary', 'handoff')

    expect(doc.consents?.[0]?.onDecline).toBe('handoff')
  })
})

describe('consent wording', () => {
  const withItalian = () => addConsentLanguage(addConsent(booking(), 'dietary', 'en'), 'dietary', 'it')

  it('adds a language once, with blank wording and labels', () => {
    const doc = addConsentLanguage(withItalian(), 'dietary', 'IT')

    expect(doc.consents?.[0]?.variants).toEqual([
      { locale: 'en', body: '', agreeLabel: '', declineLabel: '' },
      { locale: 'it', body: '', agreeLabel: '', declineLabel: '' },
    ])
  })

  it('edits one language at a time, keeping every character the operator typed', () => {
    let doc = setConsentBody(withItalian(), 'dietary', 'it', '  Chiediamo della tua dieta.\n')
    doc = setConsentAgreeLabel(doc, 'dietary', 'it', 'Accetto')
    doc = setConsentDeclineLabel(doc, 'dietary', 'it', 'No, grazie')

    expect(doc.consents?.[0]?.variants).toEqual([
      { locale: 'en', body: '', agreeLabel: '', declineLabel: '' },
      { locale: 'it', body: '  Chiediamo della tua dieta.\n', agreeLabel: 'Accetto', declineLabel: 'No, grazie' },
    ])
  })

  it('removes a language but never the last one', () => {
    const doc = removeConsentLanguage(withItalian(), 'dietary', 'it')

    expect(doc.consents?.[0]?.variants.map((variant) => variant.locale)).toEqual(['en'])
    expect(removeConsentLanguage(doc, 'dietary', 'en')).toEqual(doc)
  })
})

describe('where a consent is asked', () => {
  it('lists the sensitive fields no consent covers', () => {
    expect(uncoveredSensitiveFields(booking())).toEqual(['dietary', 'allergies'])
    expect(uncoveredSensitiveFields(addConsent(booking(), 'dietary', 'en'))).toEqual(['allergies'])
  })

  it('needs no consent for a sensitive field no step asks the visitor for', () => {
    expect(uncoveredSensitiveFields(bookingLookingUpDiagnosis())).toEqual(['dietary', 'allergies'])
  })

  it('names the steps that ask a consent first, by the step that collects each covered field', () => {
    const doc = setConsentCoversField(addConsent(booking(), 'dietary', 'en'), 'dietary', 'allergies', true)

    // ask_allergies uses dietary too, but only collects allergies: the first step that names a
    // field collects it.
    expect(consentKeysAskedBeforeStep(doc)).toEqual(new Map([['ask_diet', ['dietary']], ['ask_allergies', ['dietary']]]))
    expect(consentKeysAskedBeforeStep(booking())).toEqual(new Map())
  })
})

describe('consent diagnostics', () => {
  const diagnostic = (code: RoutineValidationDiagnostic['code'], location: string): RoutineValidationDiagnostic => ({ code, location, message: code })

  it('places each finding on the consent, its fields, its steps, or one language field', () => {
    const issues = consentIssues([
      diagnostic('consent_missing_default_variant', 'consent:dietary.variants'),
      diagnostic('consent_slot_not_sensitive', 'consent:dietary.slotKeys.guest_name'),
      diagnostic('consent_slot_not_collected', 'consent:dietary.slotKeys.diagnosis_code'),
      diagnostic('consent_step_mixes_fields', 'consent:dietary.steps.ask_diet'),
      diagnostic('consent_text_invalid', 'consent:dietary.variants[1].agreeLabel'),
      diagnostic('consent_text_invalid', 'consent:other.variants[0].body'),
      diagnostic('declared_unused_slot', 'slot:dietary'),
    ], 'dietary')

    expect(issues.consent.map((item) => item.code)).toEqual(['consent_missing_default_variant'])
    expect(issues.fields.map((item) => item.code)).toEqual(['consent_slot_not_sensitive', 'consent_slot_not_collected'])
    expect(consentDiagnosticText(issues.fields[1])).toBe('Covers a field no step asks the visitor for.')
    expect(issues.steps.map((item) => item.code)).toEqual(['consent_step_mixes_fields'])
    expect(issues.variantFields).toEqual([{ index: 1, field: 'agreeLabel', diagnostic: diagnostic('consent_text_invalid', 'consent:dietary.variants[1].agreeLabel') }])
  })
})
