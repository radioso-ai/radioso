'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { authApi } from '@/lib/api'
import { getErrorMessage } from './auth-errors'
import { AuthShell } from './auth-shell'

const VERIFY_COPY = {
  verifying: { title: 'Almost there', subtitle: 'Confirming your email address.' },
  success: { title: 'You’re all set', subtitle: 'Your email is verified. You can sign in now.' },
  error: { title: 'This link has faded', subtitle: 'Head back to sign in.' },
} as const

export function VerifyEmailScreen({ token }: { token?: string }) {
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>(() => (token ? 'verifying' : 'error'))
  const [error, setError] = useState(() => (token ? '' : 'Verification link is missing or incomplete.'))

  useEffect(() => {
    if (!token) {
      return
    }

    let cancelled = false

    const run = async () => {
      try {
        await authApi.verifyEmail({ token })
        if (!cancelled) {
          setStatus('success')
        }
      } catch (error) {
        if (!cancelled) {
          setStatus('error')
          setError(getErrorMessage(error, 'Verification failed. Request a new link and try again.'))
        }
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <AuthShell {...VERIFY_COPY[status]}>
      {status === 'verifying' ? (
        <div className="space-y-4">
          <div className="flex items-center text-sm text-muted-foreground">
            <Spinner className="mr-2" />
            Verifying link
          </div>
        </div>
      ) : null}
      {status === 'success' ? (
        <div className="space-y-4">
          <Button asChild className="w-full">
            <Link href="/">Go to Sign In</Link>
          </Button>
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="space-y-4">
          <p className="text-sm text-destructive">{error}</p>
          <Button asChild className="w-full" variant="outline">
            <Link href="/">Back to Sign In</Link>
          </Button>
        </div>
      ) : null}
    </AuthShell>
  )
}
