'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { authApi, getStoredActiveWorkspaceId, seedWorkspaceSession } from '@/lib/api'
import { getStoredLastAccountId, useOptionalAuth } from '@/lib/auth-context'

interface LoginFormProps {
  onSwitchToRegister: () => void
}

const getErrorMessage = (error: unknown) => {
  if (
    error &&
    typeof error === 'object' &&
    'error' in error &&
    error.error &&
    typeof error.error === 'object' &&
    'message' in error.error &&
    typeof error.error.message === 'string'
  ) {
    return error.error.message
  }

  return 'Login failed. Please try again.'
}

export function LoginForm({ onSwitchToRegister }: LoginFormProps) {
  const auth = useOptionalAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [verificationNotice, setVerificationNotice] = useState('')
  const [isResendingVerification, setIsResendingVerification] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setVerificationNotice('')
    setIsLoading(true)

    try {
      const preferredWorkspaceId = getStoredActiveWorkspaceId() ?? undefined
      const preferredAccountId =
        typeof window !== 'undefined' ? getStoredLastAccountId(window.localStorage) ?? undefined : undefined
      const response = await authApi.login({ email, password, preferredWorkspaceId, preferredAccountId })
      seedWorkspaceSession(response.workspaceId)
      if (!auth) {
        throw new Error('Login is unavailable outside the auth shell')
      }
      await auth.login(email, response.userId, response.accountId)
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'error' in error &&
        error.error &&
        typeof error.error === 'object' &&
        'code' in error.error &&
        error.error.code === 'email_verification_required'
      ) {
        setVerificationNotice('Verify your email before signing in. You can resend the verification email below.')
      }
      setError(getErrorMessage(error))
    } finally {
      setIsLoading(false)
    }
  }

  const handleResendVerification = async () => {
    if (!email) {
      setError('Enter your email address first.')
      return
    }

    setIsResendingVerification(true)
    setError('')

    try {
      await authApi.resendVerificationEmail({ email })
      setVerificationNotice(`Verification email sent to ${email}.`)
    } catch (error) {
      setError(getErrorMessage(error))
    } finally {
      setIsResendingVerification(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={isLoading}
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="password">Password</Label>
          <Link href="/reset-password" className="text-sm font-medium text-primary hover:underline">
            Forgot password?
          </Link>
        </div>
        <Input
          id="password"
          type="password"
          placeholder="Enter your password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          disabled={isLoading}
        />
      </div>
      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
      {verificationNotice ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{verificationNotice}</p>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={isLoading || isResendingVerification}
            onClick={handleResendVerification}
          >
            {isResendingVerification ? <Spinner className="mr-2" /> : null}
            Resend Verification Email
          </Button>
        </div>
      ) : null}
      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? <Spinner className="mr-2" /> : null}
        Sign In
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {"Don't have an account? "}
        <button
          type="button"
          onClick={onSwitchToRegister}
          className="text-primary hover:underline font-medium"
        >
          Register
        </button>
      </p>
    </form>
  )
}
