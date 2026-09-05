'use client'

import { useEffect, useState } from 'react'

import { InvitationAcceptForm } from '@/components/auth/invitation-accept-form'
import { InvitationSessionJoin } from '@/components/auth/invitation-session-join'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LogoSpinner } from '@/components/ui/spinner'
import { authApi, type InvitationDetailsResponse } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useAuth } from '@/lib/auth-context'

export function InvitationJoinScreen({ token, error: queryError }: { token: string; error?: string }) {
  const { user, isAuthenticated, isBootstrapping } = useAuth()
  const [invitation, setInvitation] = useState<InvitationDetailsResponse | null>(null)
  const [googleEnabled, setGoogleEnabled] = useState(false)
  const [isLoading, setIsLoading] = useState(() => Boolean(token))
  const [error, setError] = useState<string | null>(() => (token ? null : 'Invitation token is missing.'))

  useEffect(() => {
    let active = true

    const load = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const [response, googleStatus] = await Promise.all([
          authApi.getInvitation(token),
          authApi.getGoogleLoginStatus(),
        ])
        if (!active) return
        setInvitation(response)
        setGoogleEnabled(googleStatus.enabled)
      } catch (nextError) {
        if (!active) return
        setError(getApiErrorMessage(nextError, 'Failed to load invitation.'))
      } finally {
        if (active) {
          setIsLoading(false)
        }
      }
    }

    if (!token) {
      return () => {
        active = false
      }
    }

    void load()

    return () => {
      active = false
    }
  }, [token])

  const renderBody = () => {
    // Auth bootstrap decides between the signed-in and credential paths, so
    // nothing below can render until it settles.
    if (isBootstrapping || isLoading) {
      return (
        <div className="flex justify-center py-8">
          <LogoSpinner imageClassName="h-7 w-7" />
        </div>
      )
    }
    if (error) {
      return <p className="text-sm text-destructive">{error}</p>
    }
    if (invitation?.status !== 'pending') {
      return (
        <p className="text-sm text-muted-foreground">
          This invitation is {invitation?.status ?? 'unavailable'}.
        </p>
      )
    }
    if (isAuthenticated && user) {
      return (
        <InvitationSessionJoin
          invitationToken={token}
          invitedEmail={invitation.email}
          signedInEmail={user.email}
        />
      )
    }
    return (
      <InvitationAcceptForm
        invitationToken={token}
        invitedEmail={invitation.email}
        requiresExistingPassword={invitation.requiresExistingPassword}
        usesGoogle={invitation.federatedProviders.includes('google')}
        googleEnabled={googleEnabled}
      />
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Join account</CardTitle>
          <CardDescription>Accept your invitation with your own login.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Google returns here rather than the default landing page, so a
              failed sign-in has to be reported on this card. */}
          {queryError === 'google_login_failed' ? (
            <p className="text-sm text-destructive">Google sign-in did not complete. Try again.</p>
          ) : null}
          {renderBody()}
        </CardContent>
      </Card>
    </div>
  )
}
