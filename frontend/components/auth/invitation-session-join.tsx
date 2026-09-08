'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { authApi, seedWorkspaceSession } from '@/lib/api'
import { getApiErrorMessage, getApiErrorStatus } from '@/lib/api-error'
import { useAuth } from '@/lib/auth-context'
import { buildDashboardHref } from '@/lib/dashboard-routes'

/**
 * Join path for a visitor who already has a session. When the session belongs
 * to the invited address, the session itself is the proof of identity and no
 * credential is collected — which also makes this the only way in for a
 * federated login, whose stored password hash is unusable by design.
 */
export function InvitationSessionJoin({
  invitationToken,
  invitedEmail,
  signedInEmail,
}: {
  invitationToken: string
  invitedEmail: string
  signedInEmail: string
}) {
  const router = useRouter()
  const { login, logout } = useAuth()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleJoin = async () => {
    setError(null)
    setIsSubmitting(true)
    try {
      const response = await authApi.acceptInvitationAsCurrentUser(invitationToken)
      seedWorkspaceSession(response.workspaceId, response.workspacePublicRouteKey)
      await login(signedInEmail, response.userId, response.accountId, response.organizationName)
      router.replace(buildDashboardHref(response.accountId, {
        section: 'activity',
        workspaceId: response.workspaceId,
        workspacePublicRouteKey: response.workspacePublicRouteKey,
      }))
    } catch (nextError) {
      // The signed-in state is read from local storage, so it can outlive the
      // session cookie. Dropping it hands the visitor back to the credential
      // form instead of stranding them on a button that keeps failing.
      if (getApiErrorStatus(nextError) === 401) {
        logout()
        return
      }
      setError(getApiErrorMessage(nextError, 'Failed to accept invitation.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  if (signedInEmail.trim().toLowerCase() !== invitedEmail.trim().toLowerCase()) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          You are signed in as <span className="font-medium text-foreground">{signedInEmail}</span>,
          but this invitation is for <span className="font-medium text-foreground">{invitedEmail}</span>.
        </p>
        <Button type="button" variant="outline" className="w-full" onClick={logout}>
          Use a different account
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Signed in as <span className="font-medium text-foreground">{signedInEmail}</span>.
      </p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="button" className="w-full" onClick={handleJoin} disabled={isSubmitting}>
        {isSubmitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
        Join account
      </Button>
      <p className="text-center text-sm">
        <button
          type="button"
          onClick={logout}
          className="font-medium text-primary hover:underline"
          disabled={isSubmitting}
        >
          Use a different account
        </button>
      </p>
    </div>
  )
}
