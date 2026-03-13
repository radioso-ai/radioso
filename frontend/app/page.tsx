'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

import { useAuth } from '@/lib/auth-context'
import { AuthPage } from '@/components/auth/auth-page'
import { Spinner } from '@/components/ui/spinner'
import { buildAccountRoute } from '@/lib/dashboard-routes'

export default function Home() {
  const router = useRouter()
  const { user, isAuthenticated, isBootstrapping } = useAuth()

  useEffect(() => {
    if (!isBootstrapping && user) {
      router.replace(buildAccountRoute(user.userId, 'chat'))
    }
  }, [isBootstrapping, router, user])

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

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner className="h-6 w-6" />
    </div>
  )
}
