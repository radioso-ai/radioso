'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

import { InvitationAcceptForm } from '@/components/auth/invitation-accept-form'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LogoSpinner } from '@/components/ui/spinner'
import { authApi, type InvitationDetailsResponse } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

export default function InvitationPage() {
  const params = useParams<{ token: string }>()
  const token = typeof params?.token === 'string' ? params.token : ''
  const [invitation, setInvitation] = useState<InvitationDetailsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    const load = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const response = await authApi.getInvitation(token)
        if (!active) return
        setInvitation(response)
      } catch (nextError) {
        if (!active) return
        setError(getApiErrorMessage(nextError, 'Failed to load invitation.'))
      } finally {
        if (active) {
          setIsLoading(false)
        }
      }
    }

    if (token) {
      void load()
    } else {
      setError('Invitation token is missing.')
      setIsLoading(false)
    }

    return () => {
      active = false
    }
  }, [token])

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Join account</CardTitle>
          <CardDescription>Accept your invitation with your own login.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <LogoSpinner imageClassName="h-7 w-7" />
            </div>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : invitation?.status === 'pending' ? (
            <InvitationAcceptForm invitationToken={token} invitedEmail={invitation.email} />
          ) : (
            <p className="text-sm text-muted-foreground">
              This invitation is {invitation?.status ?? 'unavailable'}.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
