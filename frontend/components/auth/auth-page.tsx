'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { authApi } from '@/lib/api'
import { AuthShell } from './auth-shell'
import { LoginForm } from './login-form'
import { RegisterForm } from './register-form'

export type AuthMode = 'login' | 'register'

export function AuthPage({ returnTo, mode = 'login' }: { returnTo?: string; mode?: AuthMode }) {
  const searchParams = useSearchParams()
  // Registration can end in "check your inbox" instead of a session.
  const [verificationPending, setVerificationPending] = useState(false)
  const [registrationAvailable, setRegistrationAvailable] = useState<boolean | null>(null)
  const [registrationAvailabilityFailed, setRegistrationAvailabilityFailed] = useState(false)
  const [registrationRetryKey, setRegistrationRetryKey] = useState(0)

  useEffect(() => {
    let active = true
    let retryTimeout: ReturnType<typeof setTimeout> | null = null
    let automaticRetries = 0

    const loadAvailability = async () => {
      try {
        const { available } = await authApi.getRegistrationAvailability()
        if (active) {
          setRegistrationAvailable(available)
          setRegistrationAvailabilityFailed(false)
        }
      } catch {
        if (active) {
          setRegistrationAvailable(null)
          setRegistrationAvailabilityFailed(true)
          if (automaticRetries < 2) {
            automaticRetries += 1
            retryTimeout = setTimeout(() => {
              void loadAvailability()
            }, 1_500)
          }
        }
      }
    }

    void loadAvailability()

    return () => {
      active = false
      if (retryTimeout) clearTimeout(retryTimeout)
    }
  }, [registrationRetryKey])

  const heading = mode === 'login'
    ? { title: 'Back in the light', subtitle: 'Sign in to pick up where you left off.' }
    : verificationPending
      ? { title: 'Check your inbox', subtitle: 'Verify your email before signing in.' }
      : { title: 'Step into the light', subtitle: 'Create an account to get started.' }

  const footer = verificationPending ? null : mode === 'register' ? (
    <>
      Already have an account? <Link href="/login" className="font-medium text-primary hover:underline">Sign in</Link>
    </>
  ) : registrationAvailable === true ? (
    <>
      New here? <Link href="/signup" className="font-medium text-primary hover:underline">Create an account</Link>
    </>
  ) : registrationAvailable === false ? (
    'Registration is invitation-only. Ask an organization administrator for an invitation.'
  ) : registrationAvailabilityFailed ? (
    <>
      Unable to check registration availability. <Link href="/signup" className="font-medium text-primary hover:underline">Try signup</Link> or{' '}
      <button
        type="button"
        className="font-medium text-primary hover:underline"
        onClick={() => {
          setRegistrationAvailabilityFailed(false)
          setRegistrationRetryKey((key) => key + 1)
        }}
      >
        Retry registration check
      </button>
    </>
  ) : null

  return (
    <AuthShell title={heading.title} subtitle={heading.subtitle} footer={footer}>
      {/* A failed Google sign-in lands back here with the error in the
          query string and no other trace of what happened. */}
      {searchParams?.get('error') === 'google_login_failed' ? (
        <p className="text-sm text-destructive">Google sign-in did not complete. Try again.</p>
      ) : null}
      {mode === 'login' ? (
        <LoginForm returnTo={returnTo} />
      ) : (
        <RegisterForm
          returnTo={returnTo}
          onSwitchToLogin={() => window.location.assign('/login')}
          onVerificationPending={() => setVerificationPending(true)}
        />
      )}
    </AuthShell>
  )
}
