'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { authApi, getStoredActiveWorkspaceId, seedWorkspaceSession } from '@/lib/api'
import { getStoredLastAccountId, useOptionalAuth } from '@/lib/auth-context'
import { AUTH_RECOVERY_ENABLED } from '@/lib/enterprise-features'

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      const preferredWorkspaceId = getStoredActiveWorkspaceId() ?? undefined
      const preferredAccountId =
        typeof window !== 'undefined' ? getStoredLastAccountId(window.localStorage) ?? undefined : undefined
      const response = await authApi.login({ email, password, preferredWorkspaceId, preferredAccountId })
      seedWorkspaceSession(response.workspaceId, response.workspacePublicRouteKey)
      if (!auth) {
        throw new Error('Login is unavailable outside the auth shell')
      }
      await auth.login(email, response.userId, response.accountId)
    } catch (error) {
      setError(getErrorMessage(error))
    } finally {
      setIsLoading(false)
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
        <Label htmlFor="password">Password</Label>
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
      {AUTH_RECOVERY_ENABLED ? (
        <p className="text-center text-sm">
          <Link href="/reset-password" className="font-medium text-primary hover:underline">
            Forgot password?
          </Link>
        </p>
      ) : null}
    </form>
  )
}
