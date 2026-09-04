'use client'

import Image from 'next/image'
import { useEffect, useState } from 'react'
import { authApi } from '@/lib/api'
import { LoginForm } from './login-form'
import { RegisterForm } from './register-form'

export function AuthPage({ returnTo }: { returnTo?: string }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
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
            retryTimeout = setTimeout(loadAvailability, 1_500)
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Image
            src="/radioso-lockup-stacked.svg"
            alt="radioso logo"
            width={360}
            height={422}
            className="mx-auto mb-4 h-28 w-auto object-contain dark:hidden"
            priority
          />
          <Image
            src="/radioso-lockup-stacked-dark.svg"
            alt="radioso logo"
            width={360}
            height={422}
            className="mx-auto mb-4 hidden h-28 w-auto object-contain dark:block"
            priority
          />
          <p className="text-muted-foreground mt-1">Agents that answer, act, and hand off — inside the rules you set.</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
          <h2 className="text-lg font-medium text-card-foreground mb-4">
            {mode === 'login' ? 'Welcome back' : 'Create your account'}
          </h2>
          {mode === 'login' ? (
            <LoginForm
              returnTo={returnTo}
              registrationAvailable={registrationAvailable}
              registrationAvailabilityFailed={registrationAvailabilityFailed}
              onRetryRegistrationAvailability={() => {
                setRegistrationAvailabilityFailed(false)
                setRegistrationRetryKey((key) => key + 1)
              }}
              onSwitchToRegister={() => setMode('register')}
            />
          ) : (
            <RegisterForm onSwitchToLogin={() => setMode('login')} />
          )}
        </div>
      </div>
    </div>
  )
}
