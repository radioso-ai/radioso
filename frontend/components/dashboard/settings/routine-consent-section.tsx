'use client'

import { useState } from 'react'
import { Plus, ShieldCheck, Trash2 } from 'lucide-react'

import { AssistantLocaleCombobox } from '@/components/dashboard/settings/assistant-locale-combobox'
import { getAssistantLocaleLabel, resolveAssistantLocaleInput } from '@/components/dashboard/settings/assistant-locale-options'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Textarea } from '@/components/ui/textarea'
import type { RoutineValidationDiagnostic } from '@/lib/api'
import { EXACT_GREETING_BODY_MAX_CODE_POINTS, EXACT_GREETING_CHIP_LABEL_MAX_CODE_POINTS } from '@/lib/exact-greeting-editor'
import {
  addConsent,
  addConsentLanguage,
  consentDiagnosticText,
  consentFieldChoices,
  consentIssues,
  consentsOf,
  issuesForConsentVariant,
  removeConsent,
  removeConsentLanguage,
  setConsentAgreeLabel,
  setConsentBody,
  setConsentCoversField,
  setConsentDecline,
  setConsentDeclineLabel,
  uncoveredSensitiveFields,
  type ConsentDeclineChoice,
  type ConsentIssues,
  type RoutineConsentDraft,
} from '@/lib/routine-consent-editor'
import type { RoutineBlockDoc } from '@/lib/routine-prose'

type Apply = (edit: (current: RoutineBlockDoc) => RoutineBlockDoc) => void

const declineOptions: { value: ConsentDeclineChoice; label: string }[] = [
  { value: 'continue', label: 'Continue without' },
  { value: 'handoff', label: 'Hand off' },
]

const sameLocale = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase()

function Issues({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null
  return <div className="space-y-0.5">{lines.map((line, index) => <p key={`${line}-${index}`} className="text-xs text-destructive">{line}</p>)}</div>
}

function ConsentWording({ consent, index, isDefault, issues, describeField, apply }: {
  consent: RoutineConsentDraft
  index: number
  isDefault: boolean
  issues: ConsentIssues
  describeField: (slotKey: string) => string | null
  apply: Apply
}) {
  const variant = consent.variants[index]
  const language = getAssistantLocaleLabel(variant.locale)
  const fieldIssues = (field: 'locale' | 'body' | 'agreeLabel' | 'declineLabel') =>
    issuesForConsentVariant(issues, index, field).map((diagnostic) => consentDiagnosticText(diagnostic, { field }))
  return <div role="group" aria-label={`Consent wording: ${language}`} className="space-y-2 rounded-md border border-border p-3">
    <div className="flex items-center justify-between gap-2">
      <Badge variant="outline">{language}</Badge>
      {isDefault
        ? <span className="text-xs text-muted-foreground">Agent default, required</span>
        : <Button type="button" size="sm" variant="ghost" onClick={() => apply((current) => removeConsentLanguage(current, consent.key, variant.locale))}><Trash2 className="mr-1 h-3.5 w-3.5" />Remove language</Button>}
    </div>
    <Issues lines={fieldIssues('locale')} />
    {/* The covered fields sit beside the wording so the text names what the visitor agrees to share. */}
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_13rem]">
      <div className="space-y-1">
        <Textarea
          aria-label={`Consent wording (${language})`}
          value={variant.body}
          rows={3}
          placeholder="What visitors agree to, in your words"
          onChange={(event) => apply((current) => setConsentBody(current, consent.key, variant.locale, event.target.value.slice(0, EXACT_GREETING_BODY_MAX_CODE_POINTS)))}
        />
        <p className="text-xs text-muted-foreground">Shown exactly as written.</p>
        <Issues lines={fieldIssues('body')} />
      </div>
      <aside aria-label={`Fields this wording covers (${language})`} className="space-y-1 rounded-md bg-muted/40 p-2 text-xs">
        <p className="font-medium text-foreground">Name what you collect</p>
        {consent.slotKeys.length === 0
          ? <p className="text-muted-foreground">No field yet.</p>
          : <ul className="space-y-1">{consent.slotKeys.map((slotKey) => {
              const description = describeField(slotKey)
              return <li key={slotKey}><span className="rounded-sm bg-background px-1 text-foreground"><span className="text-muted-foreground">@</span>{slotKey}</span>{description ? <span className="ml-1 text-muted-foreground">{description}</span> : null}</li>
            })}</ul>}
      </aside>
    </div>
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="space-y-1">
        <Input aria-label={`Agree label (${language})`} value={variant.agreeLabel} maxLength={EXACT_GREETING_CHIP_LABEL_MAX_CODE_POINTS} placeholder="Agree label" onChange={(event) => apply((current) => setConsentAgreeLabel(current, consent.key, variant.locale, event.target.value))} />
        <Issues lines={fieldIssues('agreeLabel')} />
      </div>
      <div className="space-y-1">
        <Input aria-label={`Decline label (${language})`} value={variant.declineLabel} maxLength={EXACT_GREETING_CHIP_LABEL_MAX_CODE_POINTS} placeholder="Decline label" onChange={(event) => apply((current) => setConsentDeclineLabel(current, consent.key, variant.locale, event.target.value))} />
        <Issues lines={fieldIssues('declineLabel')} />
      </div>
    </div>
  </div>
}

function ConsentCard({ doc, consent, diagnostics, agentDefaultLocale, stepLabel, apply }: {
  doc: RoutineBlockDoc
  consent: RoutineConsentDraft
  diagnostics: RoutineValidationDiagnostic[]
  agentDefaultLocale: string
  stepLabel: (stepId: string) => string
  apply: Apply
}) {
  const [localeInput, setLocaleInput] = useState('')
  const [localeError, setLocaleError] = useState<string | null>(null)
  const issues = consentIssues(diagnostics, consent.key)
  const choices = consentFieldChoices(doc, consent.key)
  const descriptions = new Map(doc.information.map((slot) => [slot.key, slot.description ?? null]))
  const addLanguage = () => {
    const resolved = resolveAssistantLocaleInput(localeInput)
    if (!resolved) {
      setLocaleError(resolved === undefined ? 'Not a recognized language or locale tag.' : 'Choose a language.')
      return
    }
    if (consent.variants.some((variant) => sameLocale(variant.locale, resolved))) {
      setLocaleError('This consent already has that language.')
      return
    }
    apply((current) => addConsentLanguage(current, consent.key, resolved))
    setLocaleInput('')
    setLocaleError(null)
  }
  return <div role="group" aria-label={`Consent ${consent.key}`} className="space-y-3 rounded-lg border border-border p-3">
    <div className="flex items-center justify-between gap-2">
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground"><ShieldCheck className="h-4 w-4 text-muted-foreground" />{consent.key}</span>
      <Button type="button" size="sm" variant="ghost" aria-label={`Remove consent ${consent.key}`} onClick={() => apply((current) => removeConsent(current, consent.key))}><Trash2 className="mr-1 h-3.5 w-3.5" />Remove</Button>
    </div>
    <Issues lines={issues.consent.map((diagnostic) => consentDiagnosticText(diagnostic))} />
    <div className="space-y-1">
      <Label className="text-xs">Asked before collecting</Label>
      <div className="flex flex-wrap gap-2">{choices.map((choice) => {
        // A field can be uncovered at any time; it can be covered only when it is free and asked.
        const unavailable = choice.covered ? null
          : choice.coveredBy ? `Covered by ${choice.coveredBy}`
          : !choice.askedOfVisitor ? 'No step asks the visitor for it, so it needs no consent'
          : null
        return <button
          key={choice.key}
          type="button"
          role="checkbox"
          aria-checked={choice.covered}
          aria-label={`Covers ${choice.key}`}
          disabled={unavailable !== null}
          title={unavailable ?? undefined}
          onClick={() => apply((current) => setConsentCoversField(current, consent.key, choice.key, !choice.covered))}
          className={choice.covered
            ? 'rounded-full border border-primary bg-muted/40 px-3 py-1 text-sm'
            : 'rounded-full border border-border px-3 py-1 text-sm text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50'}
        >{choice.key}</button>
      })}</div>
      {consent.slotKeys.length === 0 ? <p className="text-xs text-destructive">Pick a field this consent covers.</p> : null}
      <Issues lines={issues.fields.map((diagnostic) => consentDiagnosticText(diagnostic))} />
    </div>
    <div className="space-y-1">
      <Label className="text-xs">If the visitor declines</Label>
      <div><SegmentedControl aria-label={`If the visitor declines ${consent.key}`} value={consent.onDecline} onValueChange={(value) => apply((current) => setConsentDecline(current, consent.key, value))} options={declineOptions} /></div>
      <p className="text-xs text-muted-foreground">{consent.onDecline === 'continue' ? 'The routine goes on without these fields.' : 'A person takes over the conversation.'}</p>
      <Issues lines={issues.steps.map((diagnostic) => consentDiagnosticText(diagnostic, { stepLabel }))} />
    </div>
    {consent.variants.map((variant, index) =>
      <ConsentWording key={variant.locale} consent={consent} index={index} isDefault={sameLocale(variant.locale, agentDefaultLocale)} issues={issues} describeField={(slotKey) => descriptions.get(slotKey) ?? null} apply={apply} />,
    )}
    <div className="space-y-1">
      <Label htmlFor={`consent-${consent.key}-locale`} className="text-xs">Add a language</Label>
      <div className="flex items-center gap-2">
        <div className="flex-1"><AssistantLocaleCombobox id={`consent-${consent.key}-locale`} value={localeInput} onChange={setLocaleInput} placeholder="Add a language" noFallbackOptionEnabled={false} /></div>
        <Button type="button" size="sm" variant="outline" onClick={addLanguage} disabled={!localeInput.trim()}>Add</Button>
      </div>
      {localeError ? <p className="text-xs text-destructive">{localeError}</p> : null}
    </div>
  </div>
}

/**
 * The routine's consents (#1544): the wording a visitor agrees to before a sensitive field is
 * collected, in each language, and what happens when they decline. Rendered under Collected
 * information, since every consent covers fields listed there.
 */
export function RoutineConsentSection({ doc, apply, diagnostics, agentDefaultLocale, stepLabel }: {
  doc: RoutineBlockDoc
  apply: Apply
  diagnostics: RoutineValidationDiagnostic[]
  agentDefaultLocale: string
  stepLabel: (stepId: string) => string
}) {
  const consents = consentsOf(doc)
  const uncovered = uncoveredSensitiveFields(doc)
  // Without a consent, a field still to cover is the only reason to show the section.
  if (consents.length === 0 && uncovered.length === 0) return null
  return <section aria-labelledby="routine-document-consents" className="space-y-3">
    <div className="flex items-center justify-between gap-2">
      <h2 id="routine-document-consents" className="text-xl font-semibold tracking-tight text-foreground">Consents</h2>
      {uncovered.length > 0 ? <DropdownMenu>
        <DropdownMenuTrigger asChild><Button type="button" size="sm" variant="ghost"><Plus className="mr-1 h-4 w-4" />Add consent</Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">{uncovered.map((slotKey) => <DropdownMenuItem key={slotKey} onSelect={() => apply((current) => addConsent(current, slotKey, agentDefaultLocale))}>For {slotKey}</DropdownMenuItem>)}</DropdownMenuContent>
      </DropdownMenu> : null}
    </div>
    <p className="text-sm text-muted-foreground">Visitors agree to this wording before a sensitive field is collected.</p>
    {consents.map((consent) => <ConsentCard key={consent.key} doc={doc} consent={consent} diagnostics={diagnostics} agentDefaultLocale={agentDefaultLocale} stepLabel={stepLabel} apply={apply} />)}
  </section>
}
