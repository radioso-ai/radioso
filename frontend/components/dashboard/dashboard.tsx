'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/lib/auth-context'
import { buildAccountRoute } from '@/lib/dashboard-routes'

export function Dashboard() {
  const router = useRouter()
  const { user, isBootstrapping } = useAuth()

  useEffect(() => {
    if (!isBootstrapping && user) {
      router.replace(buildAccountRoute(user.userId, 'chat'))
    }
  }, [isBootstrapping, router, user])

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner className="h-6 w-6" />
    </div>
  )
}
