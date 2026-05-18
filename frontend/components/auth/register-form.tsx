'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { authApi, seedWorkspaceSession } from '@/lib/api'
import { useOptionalAuth } from '@/lib/auth-context'

interface RegisterFormProps {
  onSwitchToLogin: () => void
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

  return 'Registration failed. Please try again.'
}

export function RegisterForm({ onSwitchToLogin }: RegisterFormProps) {
  const auth = useOptionalAuth()
  const [organizationName, setOrganizationName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isResendingVerification, setIsResendingVerification] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setMessage('')

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setIsLoading(true)

    try {
      const response = await authApi.register({
        email,
        password,
        organizationName: organizationName.trim() || undefined,
      })
      if (response.requiresEmailVerification) {
        setPendingVerificationEmail(email)
        setPassword('')
        setConfirmPassword('')
        setMessage('Check your email to verify your account before signing in.')
        return
      }
      seedWorkspaceSession(response.workspaceId, response.workspacePublicRouteKey)
      if (!auth) {
        throw new Error('Registration is unavailable outside the auth shell')
      }
      await auth.login(email, response.userId, response.accountId)
    } catch (error) {
      setError(getErrorMessage(error))
    } finally {
      setIsLoading(false)
    }
  }

  const handleResendVerification = async () => {
    if (!pendingVerificationEmail) return
    setError('')
    setMessage('')
    setIsResendingVerification(true)

    try {
      await authApi.resendEmailVerification({ email: pendingVerificationEmail })
      setMessage('Verification email sent.')
    } catch (error) {
      setError(getErrorMessage(error))
    } finally {
      setIsResendingVerification(false)
    }
  }

  if (pendingVerificationEmail) {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Verify your email</h2>
          <p className="text-sm text-muted-foreground">
            We sent a verification link to {pendingVerificationEmail}. Verify your email before signing in.
          </p>
        </div>
        {message ? (
          <p className="text-sm text-muted-foreground">{message}</p>
        ) : null}
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}
        <Button
          type="button"
          className="w-full"
          variant="outline"
          disabled={isResendingVerification}
          onClick={handleResendVerification}
        >
          {isResendingVerification ? <Spinner className="mr-2" /> : null}
          Resend verification email
        </Button>
        <Button type="button" className="w-full" onClick={onSwitchToLogin}>
          Back to Sign In
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="organizationName">Organization Name</Label>
        <Input
          id="organizationName"
          type="text"
          placeholder="Acme"
          value={organizationName}
          onChange={(e) => setOrganizationName(e.target.value)}
          maxLength={80}
          disabled={isLoading}
        />
      </div>
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
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          placeholder="At least 8 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          disabled={isLoading}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm Password</Label>
        <Input
          id="confirmPassword"
          type="password"
          placeholder="Confirm your password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          disabled={isLoading}
        />
      </div>
      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
      {message && (
        <p className="text-sm text-muted-foreground">{message}</p>
      )}
      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? <Spinner className="mr-2" /> : null}
        Create Organization
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <button
          type="button"
          onClick={onSwitchToLogin}
          className="text-primary hover:underline font-medium"
        >
          Sign in
        </button>
      </p>
    </form>
  )
}
