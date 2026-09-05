'use client'

import { Button } from '@/components/ui/button'
import { authApi } from '@/lib/api'

/**
 * Federated sign-in for the invite page. A visitor whose login is federated has
 * no usable password, so this is the only credential they can present; the
 * invited address is hinted so the account chooser lands on the right mailbox.
 */
export function InvitationGoogleButton({
  invitationToken,
  invitedEmail,
  disabled,
}: {
  invitationToken: string
  invitedEmail: string
  disabled?: boolean
}) {
  const handleClick = () => {
    window.location.assign(authApi.getGoogleLoginStartUrl({
      returnTo: `/invite/${encodeURIComponent(invitationToken)}`,
      loginHint: invitedEmail,
    }))
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      onClick={handleClick}
      disabled={disabled}
    >
      Continue with Google
    </Button>
  )
}
