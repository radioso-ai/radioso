'use client'

import { useSearchParams } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { authApi } from '@/lib/api'
import { AuthShell } from './auth-shell'
import { LoginForm } from './login-form'
import { RegisterForm } from './register-form'

export function AuthPage({ returnTo }: { returnTo?: string }) {
  const searchParams = useSearchParams()
  const [mode, setMode] = useState<'login' | 'register'>('login')
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

  const switchToLogin = () => {
    setVerificationPending(false)
    setMode('login')
  }

  const heading = mode === 'login'
    ? { title: 'Back in the light', subtitle: 'Sign in to pick up where you left off.' }
    : verificationPending
      ? { title: 'Check your inbox', subtitle: 'Verify your email before signing in.' }
      : { title: 'Step into the light', subtitle: 'Create an account to get started.' }

  const footer = verificationPending ? null : mode === 'register' ? (
    <>
      Already have an account? <FooterAction onClick={switchToLogin}>Sign in</FooterAction>
    </>
  ) : registrationAvailable === true ? (
    <>
      New here? <FooterAction onClick={() => setMode('register')}>Create an account</FooterAction>
    </>
  ) : registrationAvailable === false ? (
    'Registration is invitation-only. Ask an organization administrator for an invitation.'
  ) : registrationAvailabilityFailed ? (
    <>
      Unable to check registration availability.{' '}
      <FooterAction
        onClick={() => {
          setRegistrationAvailabilityFailed(false)
          setRegistrationRetryKey((key) => key + 1)
        }}
      >
        Retry registration check
      </FooterAction>
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
        <RegisterForm onSwitchToLogin={switchToLogin} onVerificationPending={() => setVerificationPending(true)} />
      )}
    </AuthShell>
  )
}

function FooterAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="font-medium text-primary hover:underline">
      {children}
    </button>
  )
}
