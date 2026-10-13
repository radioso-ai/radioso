'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authApi, getStoredActiveWorkspaceId, seedWorkspaceSession } from '@/lib/api'
import { getStoredLastAccountId, useOptionalAuth } from '@/lib/auth-context'
import { normalizeSameOriginReturnPath } from '@/lib/auth-return-url'
import { useAuthSunrise } from './auth-shell'
import { GoogleAuthButton } from './google-auth-button'

interface LoginFormProps {
  returnTo?: string
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

export function LoginForm({ returnTo }: LoginFormProps) {
  const auth = useOptionalAuth()
  const riseSun = useAuthSunrise()
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
      riseSun()
      await auth.login({ ...response, email })
      const target = normalizeSameOriginReturnPath(returnTo)
      if (target) {
        window.location.assign(target)
      }
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
        <div className="flex items-baseline justify-between">
          <Label htmlFor="password">Password</Label>
          <Link href="/reset-password" className="text-sm text-primary hover:underline">
            Forgot?
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
      <Button type="submit" className="w-full" loading={isLoading}>
        Sign in
      </Button>
      <GoogleAuthButton label="Sign in with Google" returnTo={returnTo} disabled={isLoading} />
    </form>
  )
}
