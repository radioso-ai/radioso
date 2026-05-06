'use client'

import Image from 'next/image'
import { useState } from 'react'
import { LoginForm } from './login-form'
import { RegisterForm } from './register-form'

export function AuthPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login')

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Image
            src="/radioso-logo.png"
            alt="radioso logo"
            width={64}
            height={64}
            className="mx-auto mb-4 h-16 w-16 rounded-2xl object-cover"
            priority
          />
          <h1 className="text-2xl font-semibold text-foreground">radioso</h1>
          <p className="text-muted-foreground mt-1">Knowledge Agents Platform</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
          <h2 className="text-lg font-medium text-card-foreground mb-4">
            {mode === 'login' ? 'Welcome back' : 'Create an organization'}
          </h2>
          {mode === 'login' ? (
            <LoginForm onSwitchToRegister={() => setMode('register')} />
          ) : (
            <RegisterForm onSwitchToLogin={() => setMode('login')} />
          )}
        </div>
      </div>
    </div>
  )
}
