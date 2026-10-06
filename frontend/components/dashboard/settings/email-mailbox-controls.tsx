'use client'

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { RefreshCw } from 'lucide-react'

import { emailChannelErrorMessage } from '@/components/dashboard/settings/email-domain-records'
import { useMailboxSettingsSave } from '@/components/dashboard/settings/use-mailbox-settings-save'
import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { emailChannelApi, type EmailMailbox } from '@/lib/api-email-channel'

// How long the backend keeps a replaced relay address forwarding.
const RELAY_GRACE_DAYS = 7

type MailboxControlProps = {
  workspaceId: string
  mailbox: EmailMailbox
  onMailboxChanged: (mailbox: EmailMailbox) => void
  announce: (message: string) => void
}

/** The one confirmation a consequential change asks for: what it does, then Confirm or Cancel. */
function ConfirmChange({
  label,
  confirmRef,
  isBusy,
  onConfirm,
  onCancel,
  children,
}: {
  label: string
  confirmRef: RefObject<HTMLButtonElement | null>
  isBusy: boolean
  onConfirm: () => void
  onCancel: () => void
  children: ReactNode
}) {
  return (
    <div className="space-y-2" role="group" aria-label={label}>
      <p className="text-sm text-foreground">{children}</p>
      <div className="flex flex-wrap gap-2">
        <Button ref={confirmRef} type="button" size="sm" disabled={isBusy} onClick={onConfirm}>
          Confirm
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={isBusy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * Focus for a control whose confirmation replaces it for a moment: the Confirm button while
 * asking, the control itself afterwards, each placed once the render that shows it has landed.
 */
function useConfirmFocus(isBusy: boolean) {
  const controlRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const focusAfterRender = useRef<'control' | 'confirm' | null>(null)

  useEffect(() => {
    const target = focusAfterRender.current
    if (!target || isBusy) return
    focusAfterRender.current = null
    ;(target === 'confirm' ? confirmRef : controlRef).current?.focus()
  })

  return {
    controlRef,
    confirmRef,
    focusControl: () => { focusAfterRender.current = 'control' },
    focusConfirm: () => { focusAfterRender.current = 'confirm' },
  }
}

/**
 * Turns a mailbox off and on. A disabled mailbox logs the mail sent to it but answers none of it,
 * so disabling asks once and says what happens to work waiting: its drafts are discarded and their
 * conversations go to a person. Enabling applies to new mail and asks nothing. Like every policy
 * change it is saved at the version read, and a change saved elsewhere reloads the mailbox.
 */
export function EmailMailboxEnabled({ workspaceId, mailbox, onMailboxChanged, announce }: MailboxControlProps) {
  const [confirming, setConfirming] = useState(false)
  const { isSaving, notice, clearNotice, save } = useMailboxSettingsSave({ workspaceId, mailbox, onMailboxChanged })
  const { controlRef, confirmRef, focusControl, focusConfirm } = useConfirmFocus(isSaving)

  const setEnabled = async (enabled: boolean) => {
    focusControl()
    const outcome = await save({ enabled }, enabled ? 'Failed to enable the mailbox.' : 'Failed to disable the mailbox.')
    if (outcome === 'saved') announce(enabled ? 'Mailbox enabled. It applies to new mail.' : 'Mailbox disabled.')
    setConfirming(false)
  }

  const toggle = () => {
    if (isSaving) return
    clearNotice()
    if (mailbox.enabled) {
      setConfirming(true)
      focusConfirm()
    } else {
      void setEnabled(true)
    }
  }

  const cancel = () => {
    setConfirming(false)
    focusControl()
  }

  return (
    <div className="space-y-2">
      <Button
        ref={controlRef}
        type="button"
        size="sm"
        variant="outline"
        onClick={toggle}
        aria-disabled={isSaving || undefined}
        aria-busy={isSaving || undefined}
      >
        {mailbox.enabled ? 'Disable mailbox' : 'Enable mailbox'}
      </Button>
      {confirming ? (
        <ConfirmChange
          label="Confirm disabling the mailbox"
          confirmRef={confirmRef}
          isBusy={isSaving}
          onConfirm={() => void setEnabled(false)}
          onCancel={cancel}
        >
          {`Mail to ${mailbox.address} is only logged until you enable it again. Pending drafts are discarded and their conversations go to a person.`}
        </ConfirmChange>
      ) : null}
      {notice ? <p className="text-sm text-destructive" role="alert">{notice}</p> : null}
    </div>
  )
}

/**
 * The relay address the customer's mail service forwards to, copied as is, and replaced when it
 * has leaked. A replacement asks once and says how long the current address keeps working, so
 * forwarding can move over without losing mail; the card then shows the new address.
 */
export function EmailMailboxRelayAddress({ workspaceId, mailbox, onMailboxChanged, announce }: MailboxControlProps) {
  const [confirming, setConfirming] = useState(false)
  const [isRotating, setIsRotating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const { controlRef, confirmRef, focusControl, focusConfirm } = useConfirmFocus(isRotating)

  const rotate = async () => {
    focusControl()
    setIsRotating(true)
    setNotice(null)
    try {
      onMailboxChanged(await emailChannelApi.rotateRelayAddress(workspaceId, mailbox.id))
      announce(`New relay address issued. Update your forwarding within ${RELAY_GRACE_DAYS} days.`)
    } catch (error) {
      setNotice(emailChannelErrorMessage(error, 'Failed to replace the relay address.'))
    } finally {
      setIsRotating(false)
      setConfirming(false)
    }
  }

  const ask = () => {
    if (isRotating) return
    setNotice(null)
    setConfirming(true)
    focusConfirm()
  }

  const cancel = () => {
    setConfirming(false)
    focusControl()
  }

  return (
    <div className="space-y-2">
      <CopyValueField label="Relay address" value={mailbox.relayAddress} ariaLabel="Copy relay address" />
      <Button
        ref={controlRef}
        type="button"
        size="sm"
        variant="ghost"
        onClick={ask}
        aria-disabled={isRotating || undefined}
        aria-busy={isRotating || undefined}
      >
        <RefreshCw aria-hidden />
        Replace relay address
      </Button>
      {confirming ? (
        <ConfirmChange
          label="Confirm replacing the relay address"
          confirmRef={confirmRef}
          isBusy={isRotating}
          onConfirm={() => void rotate()}
          onCancel={cancel}
        >
          {`Issue a new relay address? The current address keeps working for ${RELAY_GRACE_DAYS} days. Point your forwarding at the new one before then.`}
        </ConfirmChange>
      ) : null}
      {notice ? <p className="text-sm text-destructive" role="alert">{notice}</p> : null}
    </div>
  )
}
