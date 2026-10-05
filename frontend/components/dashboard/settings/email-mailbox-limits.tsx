'use client'

import { useId, useRef, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'

import { useMailboxSettingsSave } from '@/components/dashboard/settings/use-mailbox-settings-save'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { EmailMailbox } from '@/lib/api-email-channel'
import {
  mailboxLimitsChange,
  mailboxLimitsDraft,
  type MailboxLimitKey,
  type MailboxLimitsDraft,
} from '@/lib/email-mailbox-limits'

const LIMIT_FIELDS: readonly { key: MailboxLimitKey; label: string; help: string }[] = [
  { key: 'threadSendBudget', label: 'Replies per thread', help: 'Automatic replies until an operator replies.' },
  { key: 'hourlyGenerationBudget', label: 'Agent runs per hour', help: 'Past this, new mail waits for an operator.' },
  { key: 'threadContextMessages', label: 'Context messages', help: 'Earlier thread messages the agent reads.' },
  { key: 'silenceThresholdHours', label: 'Silence alert (hours)', help: 'Flags the mailbox when no mail arrives for this long.' },
]

/**
 * A mailbox's limits, edited as text and saved together with only the fields that changed. An
 * invalid field is named inline and takes focus on save; a change saved elsewhere meanwhile is
 * refused and the form reloads. The save button stays mounted, so focus stays where it was.
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
  const inputs = useRef(new Map<MailboxLimitKey, HTMLInputElement>())
  const { isSaving, notice, save } = useMailboxSettingsSave({ workspaceId, mailbox, onMailboxChanged })
  const draft: MailboxLimitsDraft = { ...mailboxLimitsDraft(mailbox), ...edits }
  const { change, errors } = mailboxLimitsChange(mailbox, draft)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSaving) return
    const firstInvalid = LIMIT_FIELDS.find(({ key }) => errors[key])
    if (firstInvalid) {
      inputs.current.get(firstInvalid.key)?.focus()
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

  const fieldId = (key: MailboxLimitKey | 'spamOptIn', part?: 'help' | 'error') => `${id}-${key}${part ? `-${part}` : ''}`

  return (
    <form aria-labelledby={`${id}-heading`} noValidate className="space-y-3" onSubmit={(event) => void submit(event)}>
      <h6 id={`${id}-heading`} className="text-sm text-foreground">Limits</h6>
      <div className="grid gap-3 sm:grid-cols-2">
        {LIMIT_FIELDS.map(({ key, label, help }) => {
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
        })}
      </div>
      <div className="flex items-start gap-2">
        <Switch
          id={fieldId('spamOptIn')}
          checked={draft.spamOptIn}
          onCheckedChange={(checked) => setEdits((current) => ({ ...current, spamOptIn: checked }))}
          aria-describedby={fieldId('spamOptIn', 'help')}
        />
        <div className="space-y-1">
          <Label htmlFor={fieldId('spamOptIn')} className="text-foreground">Spam to inbox</Label>
          <p id={fieldId('spamOptIn', 'help')} className="text-xs text-muted-foreground">
            Mail marked as spam opens an operator-only conversation.
          </p>
        </div>
      </div>
      <Button type="submit" size="sm" variant="outline" aria-busy={isSaving || undefined}>
        {isSaving ? <Loader2 className="animate-spin" aria-hidden /> : null}
        Save limits
      </Button>
      {notice ? <p className="text-sm text-destructive" role="alert">{notice}</p> : null}
    </form>
  )
}
