'use client'

import { useState } from 'react'
import { LoginForm } from './login-form'
import { RegisterForm } from './register-form'

export function AuthPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login')

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-foreground">Hivec</h1>
          <p className="text-muted-foreground mt-1">Modular RAG Platform</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
          <h2 className="text-lg font-medium text-card-foreground mb-4">
            {mode === 'login' ? 'Welcome back' : 'Create an account'}
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
