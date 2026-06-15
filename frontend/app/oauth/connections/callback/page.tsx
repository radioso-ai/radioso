'use client'

import { useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'

type CallbackStatus = 'authorized' | 'error'

const parseStatus = (value: string | null): CallbackStatus => (
  value === 'authorized' ? 'authorized' : 'error'
)

export default function OauthConnectionCallbackPage() {
  const searchParams = useSearchParams()
  const status = useMemo(() => parseStatus(searchParams.get('status')), [searchParams])
  const provider = searchParams.get('provider')

  useEffect(() => {
    if (status !== 'authorized') {
      return
    }
    window.opener?.focus()
    const timeout = window.setTimeout(() => {
      window.close()
    }, 1200)
    return () => window.clearTimeout(timeout)
  }, [status])

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-8 text-center">
      {status === 'authorized' ? (
        <>
          <h1 className="text-lg font-medium">Connected</h1>
          <p className="text-sm text-muted-foreground">
            Authorization is complete. You can close this tab and return to workspace settings.
          </p>
        </>
      ) : (
        <>
          <h1 className="text-lg font-medium">Authorization failed</h1>
          <p className="text-sm text-muted-foreground">
            {provider ? 'The provider did not complete authorization.' : 'The callback URL was missing authorization details.'}
          </p>
        </>
      )}
    </main>
  )
}
