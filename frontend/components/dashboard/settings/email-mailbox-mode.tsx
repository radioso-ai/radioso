'use client'

import { useEffect, useRef, useState } from 'react'

import { useMailboxSettingsSave } from '@/components/dashboard/settings/use-mailbox-settings-save'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import type { EmailEngagementMode, EmailMailbox } from '@/lib/api-email-channel'

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

/**
 * What the operator confirms before a change, or null when it needs no confirmation: a downgrade
 * names what happens to work in flight, and `auto` names the thread send budget it runs within.
 */
const confirmationFor = (current: EmailEngagementMode, next: EmailEngagementMode, threadSendBudget: number): string | null => {
  if (next === 'auto') {
    return `The agent sends grounded replies on its own, up to ${threadSendBudget} per thread until an operator replies.`
  }
  return AUTONOMY[next] < AUTONOMY[current] ? DOWNGRADE_CONSEQUENCE[current] : null
}

type FocusTarget = 'mode' | 'confirm'

/**
 * An existing mailbox's engagement mode, offering only what the server supports (plus the current
 * mode if it no longer does). A downgrade asks one confirmation that states what happens to work in
 * flight; switching to `auto` asks one that states its send budget and carries the opt-in. An
 * upgrade applies to new mail only. A change saved elsewhere meanwhile is refused and the mailbox
 * reloaded. Focus stays on the mode, and the card announces the result.
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
  const { isSaving, notice, clearNotice, save } = useMailboxSettingsSave({ workspaceId, mailbox, onMailboxChanged })
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

  const changeTo = async (mode: EmailEngagementMode) => {
    focusAfterRender.current = 'mode'
    const outcome = await save(
      mode === 'auto' ? { engagementMode: mode, autoOptIn: true } : { engagementMode: mode },
      'Failed to change the mode.',
    )
    if (outcome === 'saved') {
      announce(AUTONOMY[mode] > AUTONOMY[current]
        ? `Mode changed to ${MODE_LABELS[mode]}. It applies to new mail.`
        : `Mode changed to ${MODE_LABELS[mode]}.`)
    }
    setConfirming(null)
  }

  const choose = (mode: EmailEngagementMode) => {
    if (isSaving) return
    if (mode === current) {
      setConfirming(null)
      return
    }
    if (confirmationFor(current, mode, mailbox.threadSendBudget) !== null) {
      clearNotice()
      setConfirming(mode)
      focusAfterRender.current = 'confirm'
      return
    }
    void changeTo(mode)
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
            {`Change to ${MODE_LABELS[confirming]}? ${confirmationFor(current, confirming, mailbox.threadSendBudget) ?? ''}`.trim()}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button ref={confirmRef} type="button" size="sm" disabled={isSaving} onClick={() => void changeTo(confirming)}>
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
