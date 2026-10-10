'use client'

import { useState } from 'react'

import { emailChannelErrorMessage } from '@/components/dashboard/settings/email-domain-records'
import { getApiErrorCode } from '@/lib/api-error'
import { emailChannelApi, type EmailMailbox, type UpdateEmailMailboxRequest } from '@/lib/api-email-channel'

const STALE_NOTICE = 'Settings changed elsewhere, reloaded.'
const STALE_RELOAD_FAILED = 'Settings changed elsewhere. Reload the page.'

type MailboxSettingsSaveOutcome = 'saved' | 'stale' | 'failed'

/**
 * Saves one change to a mailbox's settings at the policy version it was read at. A change saved
 * elsewhere meanwhile is refused; the mailbox is then reloaded and the notice says so. Any other
 * refusal becomes the notice. The caller announces success and places focus.
 */
export function useMailboxSettingsSave({
  workspaceId,
  mailbox,
  onMailboxChanged,
}: {
  workspaceId: string
  mailbox: EmailMailbox
  onMailboxChanged: (mailbox: EmailMailbox) => void
}) {
  const [isSaving, setIsSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const save = async (
    change: Omit<UpdateEmailMailboxRequest, 'expectedPolicyVersion'>,
    failedMessage: string,
  ): Promise<MailboxSettingsSaveOutcome> => {
    setIsSaving(true)
    setNotice(null)
    try {
      const updated = await emailChannelApi.updateMailbox(workspaceId, mailbox.id, {
        ...change,
        expectedPolicyVersion: mailbox.policyVersion,
      })
      onMailboxChanged(updated)
      return 'saved'
    } catch (error) {
      if (getApiErrorCode(error) !== 'stale_policy_version') {
        setNotice(emailChannelErrorMessage(error, failedMessage))
        return 'failed'
      }
      const reloaded = await emailChannelApi.getMailbox(workspaceId, mailbox.id).then((fresh) => {
        onMailboxChanged(fresh)
        return true
      }, () => false)
      setNotice(reloaded ? STALE_NOTICE : STALE_RELOAD_FAILED)
      return 'stale'
    } finally {
      setIsSaving(false)
    }
  }

  return { isSaving, notice, clearNotice: () => setNotice(null), save }
}
