'use client'

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'

import { useMailboxSettingsSave } from '@/components/dashboard/settings/use-mailbox-settings-save'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { EmailMailbox } from '@/lib/api-email-channel'
import {
  mailboxLimitsChange,
  mailboxLimitsDraft,
  type MailboxLimitKey,
  type MailboxLimitsDraft,
} from '@/lib/email-mailbox-limits'

type LimitField = { key: MailboxLimitKey; label: string; help: string }

const BASIC_FIELDS: readonly LimitField[] = [
  { key: 'threadSendBudget', label: 'Replies per thread', help: 'Automatic replies until an operator replies.' },
]

const ADVANCED_FIELDS: readonly LimitField[] = [
  { key: 'hourlyGenerationBudget', label: 'Agent runs per hour', help: 'Past this, new mail waits for an operator.' },
  { key: 'silenceThresholdHours', label: 'Silence alert (hours)', help: 'Flags the mailbox when no mail arrives for this long.' },
]

const LIMIT_FIELDS: readonly LimitField[] = [...BASIC_FIELDS, ...ADVANCED_FIELDS]
const isAdvancedField = (key: MailboxLimitKey) => ADVANCED_FIELDS.some((field) => field.key === key)

/**
 * A mailbox's limits, edited as text and saved together with only the fields that changed. An
 * invalid field is named inline and takes focus on save; a change saved elsewhere meanwhile is
 * refused and the form reloads. The save button stays mounted, so focus stays where it was.
 * Agent runs per hour and Silence alert sit behind a closed-by-default Advanced disclosure,
 * which opens so an invalid field there is visible on save.
 */
export function EmailMailboxLimits({
  workspaceId,
  mailbox,
  onMailboxChanged,
  announce,
}: {
  workspaceId: string
  mailbox: EmailMailbox
  onMailboxChanged: (mailbox: EmailMailbox) => void
  announce: (message: string) => void
}) {
  const id = useId()
  const [edits, setEdits] = useState<Partial<MailboxLimitsDraft>>({})
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [pendingFocus, setPendingFocus] = useState<MailboxLimitKey | null>(null)
  const inputs = useRef(new Map<MailboxLimitKey, HTMLInputElement>())
  const { isSaving, notice, save } = useMailboxSettingsSave({ workspaceId, mailbox, onMailboxChanged })
  const draft: MailboxLimitsDraft = { ...mailboxLimitsDraft(mailbox), ...edits }
  const { change, errors } = mailboxLimitsChange(mailbox, draft)

  // Deferred so the input exists once the Advanced disclosure that was just opened has mounted it.
  useEffect(() => {
    if (!pendingFocus) return
    const input = inputs.current.get(pendingFocus)
    if (!input) return
    input.focus()
    setPendingFocus(null)
  }, [pendingFocus, advancedOpen])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSaving) return
    const firstInvalid = LIMIT_FIELDS.find(({ key }) => errors[key])
    if (firstInvalid) {
      if (isAdvancedField(firstInvalid.key)) setAdvancedOpen(true)
      setPendingFocus(firstInvalid.key)
      return
    }
    if (Object.keys(change).length === 0) {
      announce('No changes to save.')
      return
    }
    const outcome = await save(change, 'Failed to save the limits.')
    if (outcome === 'failed') return
    // Saved, or reloaded after a change elsewhere: either way the form shows the mailbox as it is.
    setEdits({})
    if (outcome === 'saved') announce('Limits saved.')
  }

  const fieldId = (key: MailboxLimitKey, part?: 'help' | 'error') => `${id}-${key}${part ? `-${part}` : ''}`

  const renderField = ({ key, label, help }: LimitField) => {
    const error = errors[key]
    return (
      <div key={key} className="space-y-1">
        <Label htmlFor={fieldId(key)} className="text-foreground">{label}</Label>
        <Input
          id={fieldId(key)}
          ref={(element) => {
            if (element) inputs.current.set(key, element)
            else inputs.current.delete(key)
          }}
          inputMode="numeric"
          autoComplete="off"
          className="w-28"
          value={draft[key]}
          onChange={(event) => setEdits((current) => ({ ...current, [key]: event.target.value }))}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fieldId(key, 'help')} ${fieldId(key, 'error')}` : fieldId(key, 'help')}
        />
        <p id={fieldId(key, 'help')} className="text-xs text-muted-foreground">{help}</p>
        {error ? <p id={fieldId(key, 'error')} className="text-xs text-destructive">{error}</p> : null}
      </div>
    )
  }

  return (
    <form aria-labelledby={`${id}-heading`} noValidate className="space-y-3" onSubmit={(event) => void submit(event)}>
      <h6 id={`${id}-heading`} className="text-sm text-foreground">Limits</h6>
      <div className="grid gap-3 sm:grid-cols-2">
        {BASIC_FIELDS.map(renderField)}
      </div>
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="-ml-2">
            {advancedOpen ? <ChevronDown className="mr-1.5 h-4 w-4" aria-hidden /> : <ChevronRight className="mr-1.5 h-4 w-4" aria-hidden />}
            Advanced
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {ADVANCED_FIELDS.map(renderField)}
          </div>
        </CollapsibleContent>
      </Collapsible>
      <Button type="submit" size="sm" variant="outline" aria-busy={isSaving || undefined}>
        {isSaving ? <Loader2 className="animate-spin" aria-hidden /> : null}
        Save limits
      </Button>
      {notice ? <p className="text-sm text-destructive" role="alert">{notice}</p> : null}
    </form>
  )
}
