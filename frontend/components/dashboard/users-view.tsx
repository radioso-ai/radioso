'use client'

import { useEffect, useState } from 'react'

import { accountApi, type AccountInvitationSummary, type AccountUserSummary } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'

export function UsersView({ accountId: _accountId }: { accountId: string }) {
  const [users, setUsers] = useState<AccountUserSummary[]>([])
  const [invitations, setInvitations] = useState<AccountInvitationSummary[]>([])
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [removingMembershipId, setRemovingMembershipId] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [inviteLink, setInviteLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const currentUser = users.find((user) => user.userId === currentUserId)
  const canManageUsers = currentUser?.role === 'owner'

  useEffect(() => {
    let active = true

    const load = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const response = await accountApi.listUsers()
        if (!active) return
        setUsers(response.users)
        setInvitations(response.invitations)
        setCurrentUserId(response.currentUserId)
      } catch (nextError) {
        if (!active) return
        setError(getApiErrorMessage(nextError, 'Failed to load users.'))
      } finally {
        if (active) {
          setIsLoading(false)
        }
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [])

  const handleInvite = async () => {
    if (!email.trim()) {
      return
    }

    setIsSubmitting(true)
    setError(null)
    try {
      const response = await accountApi.createInvitation(email.trim())
      setInvitations((current) => [response, ...current.filter((item) => item.id !== response.id)])
      setInviteLink(typeof window === 'undefined' ? response.acceptanceUrl : `${window.location.origin}${response.acceptanceUrl}`)
      setEmail('')
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, 'Failed to send invitation.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleRemoveUser = async (membershipId: string) => {
    setRemovingMembershipId(membershipId)
    setError(null)
    try {
      await accountApi.removeUser(membershipId)
      setUsers((current) => current.filter((user) => user.membershipId !== membershipId))
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, 'Failed to remove user access.'))
    } finally {
      setRemovingMembershipId(null)
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <LogoSpinner imageClassName="h-7 w-7" />
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-auto p-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">Users</h1>
        <p className="text-sm text-muted-foreground">
          Invite teammates to this account. All active users currently share the same access.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invite a teammate</CardTitle>
          <CardDescription>Send an email-based invitation to this account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="teammate@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={isSubmitting}
            />
          </div>
          <Button onClick={() => void handleInvite()} disabled={!email.trim() || isSubmitting}>
            {isSubmitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
            Send invite
          </Button>
          {inviteLink ? (
            <CopyValueField
              label="Latest invite link"
              value={inviteLink}
              ariaLabel="Copy latest invite link"
              wrap
            />
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active users</CardTitle>
          <CardDescription>
            {users.length === 0 ? 'No active users yet.' : `${users.length} active user${users.length === 1 ? '' : 's'}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {users.length === 0 ? (
            <p className="text-sm text-muted-foreground">This account only has the current user right now.</p>
          ) : (
            users.map((user) => (
              <div key={user.membershipId} className="rounded-lg border border-border px-4 py-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{user.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {user.role} · active since {new Date(user.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  {canManageUsers && user.role !== 'owner' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleRemoveUser(user.membershipId)}
                      disabled={removingMembershipId === user.membershipId}
                    >
                      {removingMembershipId === user.membershipId ? 'Removing...' : 'Remove access'}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invitations</CardTitle>
          <CardDescription>
            {invitations.length === 0
              ? 'No invitations yet.'
              : `${invitations.length} invitation${invitations.length === 1 ? '' : 's'} across all statuses`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {invitations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Invitation activity will appear here.</p>
          ) : (
            invitations.map((invitation) => (
              <div key={invitation.id} className="rounded-lg border border-border px-4 py-3">
                <p className="text-sm font-medium text-foreground">{invitation.email}</p>
                <p className="text-xs text-muted-foreground">
                  {invitation.status} · expires {new Date(invitation.expiresAt).toLocaleString()}
                </p>
                {invitation.acceptedAt ? (
                  <p className="text-xs text-muted-foreground">
                    accepted {new Date(invitation.acceptedAt).toLocaleString()}
                  </p>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
