'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authApi, seedWorkspaceSession } from '@/lib/api'
import { pendingRegistrationPollDelayMs } from '@/lib/auth-pending-poll'
import { useOptionalAuth } from '@/lib/auth-context'
import { useAuthSunrise } from './auth-shell'
import { GoogleAuthButton } from './google-auth-button'

interface RegisterFormProps {
  returnTo?: string
  onSwitchToLogin: () => void
  onVerificationPending: () => void
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

export function RegisterForm({ returnTo, onSwitchToLogin, onVerificationPending }: RegisterFormProps) {
  const auth = useOptionalAuth()
  const riseSun = useAuthSunrise()
  const [organizationName, setOrganizationName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState('')
  const [developmentVerificationUrl, setDevelopmentVerificationUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isResendingVerification, setIsResendingVerification] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!pendingVerificationEmail) return
    let active = true
    let completed = false
    let polling = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const schedule = (delayMs = 6_000) => {
      if (!active || completed) return
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(() => void poll(), delayMs)
    }

    async function poll() {
      if (!active || completed || polling) return
      polling = true
      try {
        const result = await authApi.exchangePendingRegistrationSession()
        if (!active) return
        if (result.ready) {
          completed = true
          window.location.assign(returnTo ?? '/')
          return
        }
        schedule()
      } catch (error) {
        // A 429 tells this browser precisely when its ticket budget is ready
        // again. Other transient failures back off rather than compounding a
        // startup outage.
        schedule(pendingRegistrationPollDelayMs(error))
      } finally {
        polling = false
      }
    }

    const pollWhenVisible = () => {
      if (document.visibilityState === 'visible') void poll()
    }

    void poll()
    window.addEventListener('focus', pollWhenVisible)
    document.addEventListener('visibilitychange', pollWhenVisible)
    return () => {
      active = false
      if (timeout) clearTimeout(timeout)
      window.removeEventListener('focus', pollWhenVisible)
      document.removeEventListener('visibilitychange', pollWhenVisible)
    }
  }, [pendingVerificationEmail, returnTo])

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
        displayName: displayName.trim() || undefined,
      })
      if (response.requiresEmailVerification) {
        setPendingVerificationEmail(email)
        setDevelopmentVerificationUrl(response.developmentVerificationUrl ?? null)
        setPassword('')
        setConfirmPassword('')
        setMessage('Check your email to verify your account before signing in.')
        onVerificationPending()
        return
      }
      seedWorkspaceSession(response.workspaceId, response.workspacePublicRouteKey)
      if (!auth) {
        throw new Error('Registration is unavailable outside the auth shell')
      }
      riseSun()
      await auth.login({ ...response, email })
      if (returnTo) {
        window.location.assign(returnTo)
      }
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
        <p className="text-sm text-muted-foreground">
          We sent a verification link to {pendingVerificationEmail}.
        </p>
        {message ? (
          <p className="text-sm text-muted-foreground">{message}</p>
        ) : null}
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}
        {developmentVerificationUrl ? (
          <Button asChild type="button" className="w-full">
            <a href={developmentVerificationUrl}>Open development verification link</a>
          </Button>
        ) : (
          <Button
            type="button"
            className="w-full"
            variant="outline"
            loading={isResendingVerification}
            onClick={handleResendVerification}
          >
            Resend verification email
          </Button>
        )}
        <Button type="button" className="w-full" onClick={onSwitchToLogin}>
          Back to Sign In
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="displayName">Your name (optional)</Label>
        <Input
          id="displayName"
          type="text"
          autoComplete="name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
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
      <div className="space-y-2">
        <Label htmlFor="organizationName">Organization name (optional)</Label>
        <Input
          id="organizationName"
          type="text"
          placeholder="Defaults to your email domain"
          value={organizationName}
          onChange={(e) => setOrganizationName(e.target.value)}
          maxLength={80}
          disabled={isLoading}
        />
      </div>
      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
      {message && (
        <p className="text-sm text-muted-foreground">{message}</p>
      )}
      <Button type="submit" className="w-full" loading={isLoading}>
        Create account
      </Button>
      <GoogleAuthButton label="Continue with Google" returnTo={returnTo} disabled={isLoading} />
    </form>
  )
}
