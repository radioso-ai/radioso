'use client'

import { useEffect, useState } from 'react'

type CallbackState = 'pending' | 'authorized' | 'error'

/**
 * Landing page for the workspace OAuth redirect. The backend completes the
 * provider callback and redirects here with `status`/`provider`. Params are read
 * from `window.location.search` in an effect (not `useSearchParams`) so the page
 * needs no Suspense boundary and prerenders cleanly, matching the MCP callback.
 */
export default function OauthConnectionCallbackPage() {
  const [state, setState] = useState<CallbackState>('pending')
  const [provider, setProvider] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const authorized = params.get('status') === 'authorized'
    // Defer the state update so the first paint matches the static prerender
    // ('pending') and we avoid a synchronous setState in the effect body.
    queueMicrotask(() => {
      setProvider(params.get('provider'))
      setState(authorized ? 'authorized' : 'error')
    })
    if (!authorized) {
      return
    }
    window.opener?.focus()
    const timeout = window.setTimeout(() => {
      window.close()
    }, 1200)
    return () => window.clearTimeout(timeout)
  }, [])

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-8 text-center">
      {state === 'pending' ? (
        <>
          <h1 className="text-lg font-medium">Finishing authorization…</h1>
          <p className="text-sm text-muted-foreground">Hold on while we connect your mail provider.</p>
        </>
      ) : null}
      {state === 'authorized' ? (
        <>
          <h1 className="text-lg font-medium">Connected</h1>
          <p className="text-sm text-muted-foreground">
            Authorization is complete. You can close this tab and return to workspace settings.
          </p>
        </>
      ) : null}
      {state === 'error' ? (
        <>
          <h1 className="text-lg font-medium">Authorization failed</h1>
          <p className="text-sm text-muted-foreground">
            {provider ? 'The provider did not complete authorization.' : 'The callback URL was missing authorization details.'}
          </p>
        </>
      ) : null}
    </main>
  )
}
