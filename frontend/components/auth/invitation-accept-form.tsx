'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { authApi, seedWorkspaceSession } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useAuth } from '@/lib/auth-context'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { MethodDivider } from '@/components/ui/method-divider'
import { InvitationGoogleButton } from './invitation-google-button'

export function InvitationAcceptForm({
  invitationToken,
  invitedEmail,
  // When a login already exists for the invited address, the backend verifies
  // that password instead of setting one. Asking to "confirm" a new password
  // here would be a lie, and a wrong guess reads as a login failure.
  requiresExistingPassword,
  // The invited login is linked to Google. That login may have no password at
  // all — federated sign-up stores an unusable hash — so the provider leads and
  // the password form becomes the alternative.
  usesGoogle,
  googleEnabled,
}: {
  invitationToken: string
  invitedEmail: string
  requiresExistingPassword: boolean
  usesGoogle: boolean
  googleEnabled: boolean
}) {
  const router = useRouter()
  const { login } = useAuth()
  const [email, setEmail] = useState(invitedEmail)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    if (!requiresExistingPassword && password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setIsSubmitting(true)
    try {
      const response = await authApi.acceptInvitation(invitationToken, { email, password })
      seedWorkspaceSession(response.workspaceId, response.workspacePublicRouteKey)
      await login(email, response.userId, response.accountId, response.organizationName)
      // An invited teammate joins an existing workspace (invitations only
      // exist on workspaces someone already set up) — the Inbox, not
      // onboarding, is the normal landing surface here, same as any other
      // authenticated entry (see app/page.tsx).
      router.replace(buildDashboardHref(response.accountId, {
        section: 'activity',
        workspaceId: response.workspaceId,
        workspacePublicRouteKey: response.workspacePublicRouteKey,
      }))
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, 'Failed to accept invitation.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  // One decision drives both the copy and the layout below.
  //
  // Google is offered only to a login already linked to it. Offering it more
  // widely would send someone with no Radioso account through provider sign-up,
  // which provisions them a fresh organization instead of joining this one —
  // the invitation is not part of that handshake. A linked login on a server
  // without Google configured has nothing to click, so it points at the reset
  // flow rather than implying a password the visitor may never have set.
  const mode = usesGoogle && googleEnabled
    ? 'federated'
    : usesGoogle
      ? 'federated_unavailable'
      : requiresExistingPassword
        ? 'existing_password'
        : 'new_password'

  const passwordPrompt = {
    federated: 'Or enter your existing password.',
    federated_unavailable:
      'This account signs in with Google, which this server does not offer. Reset your password to join.',
    existing_password: 'You already have a Radioso login. Enter your existing password to join.',
    new_password: 'Choose a password to finish setting up your login.',
  }[mode]

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {mode === 'federated' ? (
        <>
          <p className="text-sm text-muted-foreground">This account signs in with Google.</p>
          <InvitationGoogleButton
            invitationToken={invitationToken}
            invitedEmail={invitedEmail}
            disabled={isSubmitting}
          />
          <MethodDivider />
        </>
      ) : null}
      <p className="text-sm text-muted-foreground">{passwordPrompt}</p>
      <div className="space-y-2">
        <Label htmlFor="invite-email">Email</Label>
        <Input
          id="invite-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={isSubmitting}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-password">Password</Label>
        <Input
          id="invite-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={isSubmitting}
          required
        />
      </div>
      {requiresExistingPassword ? null : (
        <div className="space-y-2">
          <Label htmlFor="invite-confirm-password">Confirm password</Label>
          <Input
            id="invite-confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            disabled={isSubmitting}
            required
          />
        </div>
      )}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
        Join account
      </Button>
      {requiresExistingPassword ? (
        <p className="text-center text-sm">
          <Link
            href={`/reset-password?email=${encodeURIComponent(invitedEmail)}`}
            className="font-medium text-primary hover:underline"
          >
            Forgot password?
          </Link>
        </p>
      ) : null}
    </form>
  )
}
