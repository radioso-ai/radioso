'use client'

import { useAuth } from '@/lib/auth-context'
import { AuthPage } from '@/components/auth/auth-page'
import { Dashboard } from '@/components/dashboard/dashboard'
import { Spinner } from '@/components/ui/spinner'

export default function Home() {
  const { isAuthenticated, isBootstrapping } = useAuth()

  if (isBootstrapping) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="w-6 h-6" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <AuthPage />
  }

  return <Dashboard />
}
