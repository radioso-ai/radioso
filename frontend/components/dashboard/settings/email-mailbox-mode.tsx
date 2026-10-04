'use client'

import { useEffect, useRef, useState } from 'react'

import { emailChannelErrorMessage } from '@/components/dashboard/settings/email-domain-records'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { getApiErrorCode } from '@/lib/api-error'
import { emailChannelApi, type EmailEngagementMode, type EmailMailbox } from '@/lib/api-email-channel'

export const MODE_LABELS: Record<EmailEngagementMode, string> = {
  operator_only: 'Operator only',
  draft: 'Draft for review',
  auto: 'Automatic',
}

// How much the agent does on its own; a change to a lower rank is a downgrade.
const AUTONOMY: Record<EmailEngagementMode, number> = { operator_only: 0, draft: 1, auto: 2 }

// What a downgrade away from each mode does to work already in flight (FR-025).
const DOWNGRADE_CONSEQUENCE: Record<EmailEngagementMode, string> = {
  operator_only: '',
  draft: 'Pending drafts are discarded.',
  auto: 'Unsent automatic replies are held for review.',
}

const STALE_NOTICE = 'Settings changed elsewhere, reloaded.'
const STALE_RELOAD_FAILED = 'Settings changed elsewhere. Reload the page.'

type FocusTarget = 'mode' | 'confirm'

/**
 * An existing mailbox's engagement mode, offering only what the server supports (plus the current
 * mode if it no longer does). A downgrade asks one confirmation that states what happens to work in
 * flight; an upgrade applies to new mail only. Each change carries the policy version it was read
 * at, so a change saved elsewhere meanwhile is refused and the mailbox reloaded. Focus stays on the
 * mode, and the card announces the result.
 */
export function EmailMailboxMode({
  workspaceId,
  mailbox,
  supportedModes,
  onMailboxChanged,
  announce,
}: {
  workspaceId: string
  mailbox: EmailMailbox
  supportedModes: readonly EmailEngagementMode[]
  onMailboxChanged: (mailbox: EmailMailbox) => void
  announce: (message: string) => void
}) {
  const [confirming, setConfirming] = useState<EmailEngagementMode | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const modeRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useRef<FocusTarget | null>(null)

  useEffect(() => {
    const target = focusAfterRender.current
    if (!target || isSaving) return
    focusAfterRender.current = null
    if (target === 'confirm') confirmRef.current?.focus()
    else modeRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus()
  })

  const current = mailbox.engagementMode
  const modes = supportedModes.includes(current) ? supportedModes : [current, ...supportedModes]
  if (modes.length < 2) return null

  const save = async (mode: EmailEngagementMode) => {
    setIsSaving(true)
    setNotice(null)
    try {
      const updated = await emailChannelApi.updateMailbox(workspaceId, mailbox.id, {
        engagementMode: mode,
        expectedPolicyVersion: mailbox.policyVersion,
      })
      onMailboxChanged(updated)
      announce(AUTONOMY[mode] > AUTONOMY[current]
        ? `Mode changed to ${MODE_LABELS[mode]}. It applies to new mail.`
        : `Mode changed to ${MODE_LABELS[mode]}.`)
    } catch (error) {
      if (getApiErrorCode(error) === 'stale_policy_version') {
        const reloaded = await emailChannelApi.getMailbox(workspaceId, mailbox.id).then((fresh) => {
          onMailboxChanged(fresh)
          return true
        }, () => false)
        setNotice(reloaded ? STALE_NOTICE : STALE_RELOAD_FAILED)
      } else {
        setNotice(emailChannelErrorMessage(error, 'Failed to change the mode.'))
      }
    } finally {
      setConfirming(null)
      setIsSaving(false)
      focusAfterRender.current = 'mode'
    }
  }

  const choose = (mode: EmailEngagementMode) => {
    if (isSaving) return
    if (mode === current) {
      setConfirming(null)
      return
    }
    if (AUTONOMY[mode] < AUTONOMY[current]) {
      setNotice(null)
      setConfirming(mode)
      focusAfterRender.current = 'confirm'
      return
    }
    void save(mode)
  }

  const cancel = () => {
    setConfirming(null)
    focusAfterRender.current = 'mode'
  }

  return (
    <div className="space-y-2">
      <div ref={modeRef} className="flex flex-wrap items-center gap-2" aria-busy={isSaving || undefined}>
        <span className="text-sm text-foreground">Mode</span>
        <SegmentedControl
          aria-label="Mailbox mode"
          value={current}
          onValueChange={choose}
          options={modes.map((mode) => ({ value: mode, label: MODE_LABELS[mode] }))}
        />
      </div>
      {confirming ? (
        <div className="space-y-2" role="group" aria-label="Confirm mode change">
          <p className="text-sm text-foreground">
            {`Change to ${MODE_LABELS[confirming]}? ${DOWNGRADE_CONSEQUENCE[current]}`.trim()}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button ref={confirmRef} type="button" size="sm" disabled={isSaving} onClick={() => void save(confirming)}>
              Confirm
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={isSaving} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {notice ? <p className="text-sm text-destructive" role="alert">{notice}</p> : null}
    </div>
  )
}
