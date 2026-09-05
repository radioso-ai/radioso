'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { authApi, seedWorkspaceSession } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { getErrorMessage } from './auth-errors'

export function ResetPasswordScreen({ token, email: initialEmail }: { token?: string; email?: string }) {
  const router = useRouter()
  const { login } = useAuth()
  // Prefilled when the visitor arrives from a flow that already knows the
  // address, such as an invitation for a login they cannot sign in to.
  const [email, setEmail] = useState(initialEmail ?? '')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [requestAccepted, setRequestAccepted] = useState(false)
  const [error, setError] = useState('')

  const handleRequestSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setIsLoading(true)
    setError('')

    try {
      await authApi.requestPasswordReset({ email })
      setRequestAccepted(true)
    } catch (error) {
      setError(getErrorMessage(error, 'Password reset request failed. Please try again.'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleConfirmSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setIsLoading(true)

    try {
      const response = await authApi.confirmPasswordReset({ token: token ?? '', password })
      seedWorkspaceSession(response.workspaceId, response.workspacePublicRouteKey)
      await login(response.email, response.userId, response.accountId, response.organizationName)
      // Resetting a password only happens for an account that already
      // exists — never a genuinely first-run workspace — so the Inbox is
      // the normal landing surface here, same as any other authenticated
      // entry (see app/page.tsx).
      router.replace(buildDashboardHref(response.accountId, {
        section: 'activity',
        workspaceId: response.workspaceId,
        workspacePublicRouteKey: response.workspacePublicRouteKey,
      }))
    } catch (error) {
      setError(getErrorMessage(error, 'Password reset failed. Please request a new link.'))
    } finally {
      setIsLoading(false)
    }
  }

  const isConfirmMode = Boolean(token)

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="mb-2 text-xl font-semibold text-card-foreground">
          {isConfirmMode ? 'Choose a new password' : 'Reset your password'}
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">
          {isConfirmMode
            ? 'Enter your new password to restore access.'
            : 'Enter your email and we will send a reset link if the account exists.'}
        </p>

        {isConfirmMode ? (
          <form onSubmit={handleConfirmSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">New Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 8 characters"
                required
                disabled={isLoading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm New Password</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Confirm your password"
                required
                disabled={isLoading}
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? <Spinner className="mr-2" /> : null}
              Reset Password
            </Button>
          </form>
        ) : requestAccepted ? (
          <p className="text-sm text-muted-foreground">
            If that email exists, a reset link is on its way.
          </p>
        ) : (
          <form onSubmit={handleRequestSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="reset-email">Email</Label>
              <Input
                id="reset-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
                disabled={isLoading}
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? <Spinner className="mr-2" /> : null}
              Send Reset Link
            </Button>
          </form>
        )}

        <div className="mt-4 text-center text-sm text-muted-foreground">
          <Link href="/" className="text-primary hover:underline">
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  )
}
